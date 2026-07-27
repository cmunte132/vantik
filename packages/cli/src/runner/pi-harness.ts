import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';

import { breach, newSpend } from './budget';
import type {
  ContextPack,
  Harness,
  HarnessRequest,
  HarnessResult,
  VerificationCommands,
} from './contract';
import { RunnerError } from './failures';

/**
 * The pinned harness build.
 *
 * Pinned rather than floating, and recorded on every run alongside the model
 * id. Two runs of the same issue are only comparable if you know what drove
 * them, and "latest" is not an answer to that question three weeks later.
 *
 * Declared here *and* in `@vantikhq/types` for the hosted executor. Not shared,
 * because this package is published on its own and does not depend on the
 * types package — importing it for a version string would pull the whole
 * server-side type surface into this bundle. `pi-version.spec.ts` on the
 * server reads this file and fails if the two ever disagree, so the
 * duplication cannot drift silently.
 */
export const PI_VERSION = '0.82.1';
export const PI_PACKAGE = `@earendil-works/pi-coding-agent@${PI_VERSION}`;

/**
 * Pi, driven over its RPC mode.
 *
 * Chosen on licence and neutrality grounds rather than benchmark scores: MIT,
 * TypeScript, model-agnostic across twenty-odd providers. The alternative that
 * would otherwise be obvious is Claude-only and proprietary, which is a poor
 * fit for an AGPL project whose users hold credentials of every kind.
 *
 * Driven over `--mode rpc` — strict LF-delimited JSONL on stdin and stdout —
 * which is the harness contract already specified rather than one this project
 * had to invent.
 */
export class PiHarness implements Harness {
  readonly name = 'pi';

  constructor(
    private options: {
      /** Overrides the bundled `npx pi` invocation. */
      command?: string;
      model?: string;
      provider?: string;
      /**
       * How hard the model is asked to think — Pi's `--thinking`, one of
       * off, minimal, low, medium, high, xhigh, max.
       */
      thinking?: string;
      /** Vantik-controlled extension directory. Never a project-local one. */
      extensions?: string[];
    } = {},
  ) {}

  /**
   * What actually drove this run.
   *
   * Reports the overriding command rather than the pinned Pi version when one
   * is set. Recording `pi@0.82.1` for a run some other harness performed makes
   * every later comparison between runs a lie, which is precisely what this
   * field exists to prevent.
   */
  async version(): Promise<string> {
    return this.options.command
      ? `custom:${this.options.command.split(' ')[0]}`
      : `pi@${PI_VERSION}`;
  }

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const started = Date.now();
    const spend = newSpend();
    let modelId = this.options.model;
    let stopped: string | null = null;
    const summaryParts: string[] = [];

    const [command, ...rest] = this.args();

    if (!command) {
      throw new RunnerError(
        'HARNESS_CRASHED',
        'The harness command is empty. Pass --harness, or leave it unset for the bundled default.',
      );
    }

    // Default stdio is a pipe on all three, which is what the JSONL protocol
    // needs; naming it explicitly only confuses the overload resolution.
    const child: ChildProcessWithoutNullStreams = spawn(command, rest, {
      cwd: request.workdir,
      env: harnessEnv(),
    });

    const abort = () => {
      child.kill('SIGTERM');
      // A harness mid-tool-call may ignore SIGTERM; do not wait for ever.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    };
    request.signal.addEventListener('abort', abort, { once: true });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-8000);
    });

    // Split on LF and nothing else. Node's `readline` also breaks on U+2028
    // and U+2029, which are legal inside a JSON string — so a model that emits
    // either in code or prose would split one record into two and lose it. Pi's
    // own RPC documentation calls readline out by name for this.
    let pending = '';

    child.stdout.on('data', (chunk: Buffer) => {
      pending += String(chunk);

      const records = pending.split('\n');
      // The last piece has no newline yet: it is the start of the next record.
      pending = records.pop() ?? '';

      for (const record of records) {
        onLine(record);
      }
    });

    // RPC mode is a server, not a command. It answers a prompt and waits for
    // the next one, so nothing about finishing the work makes the process
    // exit. `agent_settled` is the signal that the run is over — no retry, no
    // compaction, no queued follow-up left — and it is what ends the session
    // here. Waiting for the process to close instead means every run burns its
    // whole wall-clock budget and then reports BUDGET_EXHAUSTED.
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolveSettled) => {
      settle = resolveSettled;
    });

    function onLine(line: string) {
      const event = parseLine(line);
      if (!event) {
        return;
      }

      // Structured progress, not a transcript dump. Only the harness knows
      // where its phases begin, which is why this mapping lives here.
      const mapped = describe(event);
      if (mapped) {
        request.onEvent(mapped);
      }

      if (event.type === 'tool_execution_start') {
        // Any tool call is evidence the agent is working rather than talking.
        spend.idleTurns = -1;
      }

      if (event.type === 'auto_retry_start') {
        spend.consecutiveRetries += 1;
      }

      if (event.type === 'turn_end') {
        spend.iterations += 1;
        spend.idleTurns += 1;
        spend.consecutiveRetries = 0;
      }

      const usage = usageOf(event);
      if (usage) {
        spend.tokens += usage.tokens;
        spend.costUsd += usage.costUsd;
      }

      const model = modelOf(event);
      if (model) {
        modelId = model;
      }

      const text = assistantTextOf(event);
      if (text) {
        summaryParts.push(text);
      }

      // Checked after every event, so a run stops at the ceiling rather than
      // at the end of whatever it was in the middle of.
      if (!stopped) {
        stopped = breach(spend, request.limits ?? {});

        if (stopped) {
          request.onEvent({
            message: `Stopping this run: ${stopped}`,
            level: 'WARN',
            phase: 'implement',
          });

          // Ask Pi to stop the turn it is in before closing the session, so a
          // tool call in flight is cancelled rather than orphaned.
          child.stdin.write(`${JSON.stringify({ type: 'abort' })}\n`);
          settle?.();
        }
      }

      if (event.type === 'agent_settled') {
        settle?.();
      }
    }

    child.stdin.write(
      `${JSON.stringify({ type: 'prompt', message: prompt(request.contextPack, request.verification) })}\n`,
    );

    const exited = new Promise<number>((resolveExit, rejectExit) => {
      child.on('error', rejectExit);
      child.on('close', (exitCode: number | null) => resolveExit(exitCode ?? 1));
    });

    // Whichever comes first: the agent settling, or the process going away of
    // its own accord — a custom harness that is a plain command still exits,
    // and it will never send `agent_settled`.
    const code = await Promise.race([
      settled.then(async () => {
        // Closing stdin is how a well-behaved RPC server is asked to stop. The
        // kill is the backstop for one that does not take the hint.
        child.stdin.end();
        return await Promise.race([
          exited,
          new Promise<number>((resolveExit) =>
            setTimeout(() => {
              child.kill('SIGTERM');
              resolveExit(0);
            }, 5_000).unref(),
          ),
        ]);
      }),
      exited,
    ]).catch((error) => {
      throw new RunnerError(
        'HARNESS_CRASHED',
        `Could not start the harness (${command} ${rest.join(' ')}): ${(error as Error).message}`,
        error,
      );
    });

    request.signal.removeEventListener('abort', abort);

    // A ceiling reached is a different thing from a wall clock expiring, and
    // the reason is the whole value: "it stopped" is not a finding.
    if (stopped) {
      return {
        outcome: 'failed',
        failure: 'BUDGET_EXHAUSTED',
        error: stopped,
        summary: summaryParts.slice(-1)[0]?.trim().slice(0, 4000),
        harnessVersion: await this.version(),
        modelId,
        iterationCount: spend.iterations,
        costUsd: spend.costUsd,
      };
    }

    if (request.signal.aborted) {
      return {
        outcome: 'failed',
        failure: 'BUDGET_EXHAUSTED',
        error: `The run was stopped after ${Math.round((Date.now() - started) / 1000)}s.`,
        harnessVersion: await this.version(),
        modelId,
        iterationCount: spend.iterations,
        costUsd: spend.costUsd,
      };
    }

    if (code !== 0) {
      return {
        outcome: 'failed',
        failure: 'HARNESS_CRASHED',
        error: `The harness exited ${code}.\n${stderr.trim()}`.slice(0, 4000),
        harnessVersion: await this.version(),
        modelId,
        iterationCount: spend.iterations,
        costUsd: spend.costUsd,
      };
    }

    return {
      // Whether anything actually changed is the daemon's call, from the diff.
      // A harness saying "I changed things" is not evidence that it did.
      outcome: 'changed',
      summary: summaryParts.slice(-1)[0]?.trim().slice(0, 4000),
      harnessVersion: await this.version(),
      modelId,
      iterationCount: spend.iterations,
        costUsd: spend.costUsd,
    };
  }

  /**
   * How Pi is invoked.
   *
   * `--no-extensions` is the load-bearing flag. Pi otherwise auto-discovers
   * extensions from `.pi/extensions/*.ts` **in the project directory** and
   * executes them with full system access — which, for an agent pointed at
   * arbitrary repositories, is a code-execution path controlled by whoever can
   * land a file in the repo. With this flag only paths passed explicitly via
   * `--extension` load, so extensions come from a directory we control and
   * nowhere else.
   */
  private args(): string[] {
    if (this.options.command) {
      return this.options.command.split(' ').filter(Boolean);
    }

    const args = [
      'npx',
      '--yes',
      PI_PACKAGE,
      '--mode',
      'rpc',
      '--no-extensions',
      // Unattended: there is no human to approve a tool call, and a harness
      // blocked on a prompt burns its lease waiting for one.
      '--no-approve',
    ];

    for (const extension of this.options.extensions ?? []) {
      args.push('--extension', extension);
    }
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.options.provider) {
      args.push('--provider', this.options.provider);
    }
    if (this.options.thinking) {
      args.push('--thinking', this.options.thinking);
    }

    return args;
  }
}

/**
 * The environment the harness runs in.
 *
 * The Vantik credential is removed rather than merely not passed. The harness
 * has a shell and can read its own environment, so anything left in here is
 * effectively readable by a prompt-injected agent — and the runner's token can
 * write to the tracker.
 */
function harnessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete env.VANTIK_TOKEN;
  delete env.ACCESS_TOKEN;

  return env;
}

/** One JSONL line, or null when the harness wrote something that is not one. */
function parseLine(line: string): Record<string, never> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Turns a harness event into a progress line worth storing, or nothing. */
export function describe(
  event: Record<string, never>,
): { message: string; phase?: string; level?: 'INFO' | 'WARN' | 'ERROR' } | null {
  const type = String(event.type ?? '');

  // Pi's names, not the ones an earlier draft of this file guessed. It emits
  // `tool_execution_start`, never `tool_call`, so the only event that used to
  // match was `turn_end` — which is why a whole run logged nothing but
  // "Finished a turn" and a reader could not tell what it had done.
  if (type === 'tool_execution_start') {
    const name = String(event.toolName ?? 'a tool');
    const detail = describeToolArgs(event.args);

    return {
      message: detail ? `${name}: ${detail}` : `Running ${name}`,
      phase: 'implement',
    };
  }
  if (type === 'auto_retry_start') {
    return {
      message: 'The model call failed; retrying',
      level: 'WARN',
      phase: 'implement',
    };
  }
  if (type === 'compaction_start') {
    return { message: 'Compacting the context', phase: 'implement' };
  }
  if (type === 'extension_error' || type === 'error') {
    return {
      message: String(event.message ?? 'The harness reported an error'),
      level: 'ERROR',
      phase: 'implement',
    };
  }
  if (type === 'turn_end') {
    return { message: 'Finished a turn', phase: 'implement' };
  }

  // Everything else is transcript noise. Storing it would make a failed run
  // harder to read, not easier.
  return null;
}

/** The one fact about a tool call worth a log line: what it acted on. */
function describeToolArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) {
    return null;
  }

  const record = args as Record<string, unknown>;
  const interesting = record.command ?? record.path ?? record.file_path;

  return typeof interesting === 'string'
    ? (interesting.split('\n')[0] ?? '').slice(0, 120) || null
    : null;
}

/** Tokens and dollars from one message, when the provider reported them. */
function usageOf(
  event: Record<string, never>,
): { tokens: number; costUsd: number } | null {
  const message = event.message as { usage?: unknown } | undefined;
  const usage = message?.usage as
    | { input?: unknown; output?: unknown; cost?: { total?: unknown } }
    | undefined;

  if (!usage) {
    return null;
  }

  const input = typeof usage.input === 'number' ? usage.input : 0;
  const output = typeof usage.output === 'number' ? usage.output : 0;
  const total = usage.cost?.total;

  return {
    tokens: input + output,
    costUsd: typeof total === 'number' ? total : 0,
  };
}

/**
 * The model that actually answered.
 *
 * Read off the message rather than trusted from the flag: `--model` is a
 * pattern Pi resolves against what the provider offers, so the id that ran is
 * not always the id that was asked for, and the whole point of recording it is
 * that two runs can be compared afterwards.
 */
export function modelOf(event: Record<string, never>): string | null {
  if (typeof event.model === 'string') {
    return event.model;
  }

  const message = event.message as { model?: unknown } | undefined;

  return typeof message?.model === 'string' ? message.model : null;
}

/**
 * The assistant's own prose from a finished message.
 *
 * Pi carries it as content blocks on `message_end`, not as a `text` field on a
 * `message` event — which the previous shape looked for and never found, so no
 * run ever captured a summary.
 */
export function assistantTextOf(event: Record<string, never>): string | null {
  if (event.type !== 'message_end') {
    return null;
  }

  const message = event.message as
    | { role?: unknown; content?: unknown }
    | undefined;

  if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
    return null;
  }

  const text = message.content
    .filter(
      (block: unknown): block is { type: string; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();

  return text || null;
}

/**
 * The prompt.
 *
 * The Definition of Done goes in as a numbered list rather than prose, because
 * it is the standard the work is judged against and a criterion the agent can
 * point at is more useful than a paragraph it can paraphrase. The verification
 * commands are stated as instructions rather than offered as options — an
 * agent that does not run the tests is the failure mode this whole design is
 * arranged to avoid.
 */
function prompt(pack: ContextPack, verification: VerificationCommands): string {
  const parts: string[] = [
    `You are working on ${pack.issue.key}: ${pack.issue.title}`,
    '',
    pack.issue.description || '(no description)',
  ];

  if (pack.definitionOfDone?.length) {
    parts.push(
      '',
      '## Definition of Done',
      '',
      'This is the standard your work is judged against. Satisfy every open item:',
      '',
      ...pack.definitionOfDone
        .filter((criterion) => !criterion.completed)
        .map((criterion, index) => `${index + 1}. ${criterion.body}`),
    );
  }

  if (pack.subTasks?.length) {
    parts.push(
      '',
      '## Sub-tasks',
      '',
      ...pack.subTasks.map(
        (sub) => `- ${sub.done ? '[x]' : '[ ]'} ${sub.key} ${sub.title}`,
      ),
    );
  }

  if (pack.relations?.length) {
    parts.push(
      '',
      '## Related work — do not break these',
      '',
      ...pack.relations.map(
        (relation) => `- ${relation.type} ${relation.key}: ${relation.title}`,
      ),
    );
  }

  if (pack.comments?.length) {
    parts.push(
      '',
      '## Discussion',
      '',
      ...pack.comments
        .slice(-10)
        .map((comment) => `**${comment.author ?? 'someone'}**: ${comment.body}`),
    );
  }

  if (pack.knowledge?.length) {
    parts.push(
      '',
      '## What this workspace already knows',
      '',
      ...pack.knowledge.map((entry) => `- (${entry.scope}) ${entry.body}`),
    );
  }

  const commands = Object.entries({
    Tests: verification.test,
    Typecheck: verification.typecheck,
    Lint: verification.lint,
    Build: verification.build,
  }).filter(([, command]) => Boolean(command));

  if (commands.length) {
    parts.push(
      '',
      '## Verify your work',
      '',
      'Run these and make them pass before you finish. If one fails, fix the',
      'cause rather than the check:',
      '',
      ...commands.map(([label, command]) => `- ${label}: \`${command}\``),
    );
  }

  parts.push(
    '',
    '## How to finish',
    '',
    'Make the change, run the verification above, and stop. Do not commit,',
    'branch, push, or open a pull request — that is handled for you. Do not',
    'edit unrelated files. When you are done, state in one short paragraph',
    'what you changed and why.',
  );

  return parts.join('\n');
}
