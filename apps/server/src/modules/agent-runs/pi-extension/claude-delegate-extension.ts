/**
 * The `claude_delegate` tool for omp: hands a task to the official Claude Code
 * CLI, signed in with the user's own Claude subscription, and reports what it
 * did and what it cost.
 *
 * It registers an external agent tool, not a provider or a model: the agent
 * calls the tool, the tool runs the unmodified `claude` binary, and the result
 * comes back as text with the full record in `details`. The Vantik ingestion
 * reads `details` as the one authoritative source of this run's usage, so the
 * extension appends nothing of its own.
 *
 * It also registers two commands that go through the same path:
 * `/claude-smoke` runs a fixed, tool-free reply to prove the wiring, and
 * `/claude-status` checks the login without any inference.
 *
 * Imports Node's built-ins and its sibling `claude-cli` only, so it bundles
 * with nothing else and runs in any omp that loads extensions.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  checkAuth,
  createCheckpointStore,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  delegate,
  describeAuth,
  describeDelegation,
  type DelegateDeps,
  type DelegateDetails,
  INTENTS,
  MAX_TIMEOUT_MS,
  MAX_TURNS,
  parseDelegateParams,
  SMOKE_PROMPT,
  smokeLine,
  TOOL_PROFILES,
} from './claude-cli';
import {
  registerDelegationRouting,
  type RoutingContext,
  type RoutingPi,
  type RoutingTool,
} from './delegation-routing';

/** The slice of omp's extension API this uses, so nothing is imported at run time. */
export interface DelegatePi extends RoutingPi {
  registerTool?(tool: DelegateTool | RoutingTool): void;
  registerCommand?(name: string, command: DelegateCommand): void;
}

/** The context omp passes a tool or a command. Every field may be absent. */
export interface DelegateContext extends RoutingContext {
  cwd?: string;
  sessionManager?: { getSessionId?(): string };
}

export interface DelegateCommand {
  description: string;
  handler(args: string, ctx: DelegateContext): Promise<void> | void;
}

/** The slice of omp's tool definition this uses. */
export interface DelegateTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  /** omp shows the model only the tools marked `essential`. */
  loadMode?: 'essential';
  /** Running Claude is an execution with consequences, so it asks as `exec` does. */
  approval?: 'exec';
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: DelegateContext,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: DelegateDetails;
  }>;
}

/**
 * Where the per-session checkpoints live. Metadata only: session ids, totals
 * and times, never a prompt, a result or a credential.
 */
export function delegationDir(home: string = homedir()): string {
  return join(home, '.omp', 'agent', 'claude-delegation');
}

export default function claudeDelegate(host: DelegatePi) {
  registerDelegationRouting(host);
  const deps: DelegateDeps = {
    binary: 'claude',
    env: process.env,
    store: createCheckpointStore(delegationDir()),
    now: () => new Date().toISOString(),
  };

  host.registerTool?.({
    name: 'claude_delegate',
    label: 'Claude Code',
    description:
      'Hand a self-contained task to Claude Code, the official Claude CLI, running on the user’s own Claude subscription. ' +
      'It runs in the given directory with only the tools you choose: none, read (read and search files, the default), or edit (also edit and write files). ' +
      'It cannot run shell commands or spawn subagents. Give the prompt everything it needs, because it starts with no memory of this conversation. ' +
      'The default model is claude-haiku-5-5. Pass resumeSessionId from an earlier result to continue that session. ' +
      'The result says what Claude did and what it cost on the API-equivalent list price, which is not cash or quota. Check the status and error before you rely on the reply.',
    promptSnippet:
      'claude_delegate: delegate a self-contained task to the official Claude CLI on the user’s subscription',
    loadMode: 'essential',
    approval: 'exec',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The task, complete enough to work alone: the goal, the files, and what done looks like.',
        },
        intent: {
          type: 'string',
          enum: [...INTENTS],
          description:
            'What the delegation is for: execution (do the work), reasoning (think it through), or review (check existing work).',
        },
        cwd: {
          type: 'string',
          description:
            'Absolute directory to run in. Defaults to the current working directory.',
        },
        model: {
          type: 'string',
          description: `Claude model id. Defaults to ${DEFAULT_MODEL}.`,
        },
        toolProfile: {
          type: 'string',
          enum: [...TOOL_PROFILES],
          description:
            'none: no tools. read (default): read and search. edit: also edit and write files.',
        },
        resumeSessionId: {
          type: 'string',
          description:
            'The claudeSessionId from an earlier result, to continue that session.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          description: `How long the run may take, in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
        },
        maxTurns: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TURNS,
          description: 'The most agent turns Claude may take.',
        },
      },
      required: ['prompt', 'intent'],
      additionalProperties: false,
    },
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      const cwd = ctx?.cwd ?? process.cwd();
      const request = parseDelegateParams(params, cwd);

      const details = await delegate(
        {
          ...request,
          invocationId: toolCallId,
          ompSessionId: ompSessionOf(ctx),
          signal,
        },
        deps,
      );

      return {
        content: [{ type: 'text', text: describeDelegation(details) }],
        details,
      };
    },
  } satisfies DelegateTool);

  host.registerCommand?.('claude-smoke', {
    description:
      'Run a fixed tool-free Claude reply through the delegation path to check it works.',
    handler: async (_args, ctx) => {
      const details = await delegate(
        {
          prompt: SMOKE_PROMPT,
          intent: 'execution',
          cwd: ctx?.cwd ?? process.cwd(),
          toolProfile: 'none',
          invocationId: `smoke-${randomUUID()}`,
          ompSessionId: ompSessionOf(ctx),
        },
        deps,
      );
      show(ctx, smokeLine(details));
    },
  });

  host.registerCommand?.('claude-status', {
    description:
      'Check the Claude login without running a model: shows only the method and plan.',
    handler: async (_args, ctx) => {
      const auth = await checkAuth(deps, ctx?.cwd ?? process.cwd());
      show(ctx, describeAuth(auth));
    },
  });
}

function ompSessionOf(ctx: DelegateContext | undefined): string | null {
  return ctx?.sessionManager?.getSessionId?.() ?? null;
}

/** Shows a line to the person when omp has a UI, and to stderr otherwise. */
function show(ctx: DelegateContext | undefined, line: string) {
  if (ctx?.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(line, 'info');
    return;
  }
  // stdout carries omp's event stream, so a line for a person goes to stderr.
  process.stderr.write(`${line}\n`);
}
