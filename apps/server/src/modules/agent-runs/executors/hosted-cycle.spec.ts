import type {
  SandboxExecOptions,
  SandboxHandle,
  SandboxSpec,
} from '@vantikhq/types';

import { HostedExecutor } from './hosted.executor';
import { RunOutboxService } from '../run-outbox';

/**
 * The implement → verify → review → revise cycle, driven end to end against a
 * fake guest.
 *
 * Everything below the executor is faked and everything inside it is real: the
 * loop, the prompts, the budget, the decision about when to stop and what
 * status to finish in. That is the half worth testing. A microVM is not
 * available in CI and never will be, and the parts that need one — does the
 * agent write good code, does the reviewer read it well — are not decidable by
 * a test anyway.
 *
 * What is decidable, and what these cover, is the wiring nobody sees fail: that
 * a reviewer runs at all, that it is a *separate* invocation in the *same*
 * guest, that its findings reach the next pass, that a run which nothing signed
 * off does not report itself as a success, and that the budget is a ceiling
 * rather than a suggestion.
 */

const WORKSPACE = 'workspace-1';
const RUN = 'run-1';

/** A Pi event stream, as the harness would print it. */
let generation = 0;

function piOutput(summary: string): string {
  generation += 1;
  return [
    JSON.stringify({ type: 'turn_end' }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        responseId: `gen-${generation}`,
        content: [{ type: 'text', text: summary }],
        usage: { cost: { total: 0.5 } },
      },
    }),
  ].join('\n');
}

/**
 * A stream from a harness whose model refused it.
 *
 * Exit code zero, deliberately: that is what Pi really does when the provider
 * turns it away, and reading it as a pass that simply had nothing to say is
 * the failure these fixtures exist to pin down.
 */
function piRefusal(errorMessage: string): string {
  return [
    JSON.stringify({ type: 'turn_end' }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stopReason: 'error',
        errorMessage,
      },
    }),
  ].join('\n');
}

interface GuestScript {
  /**
   * What the sandbox host's meter answers: the provider's billed cost for
   * every call it saw. Absent means a runtime that meters nothing.
   */
  billedPerCall?: number;
  /** Verdict JSON per pass, keyed by pass number. Absent means no file. */
  verdicts: Record<number, string | undefined>;
  /** A model refusal instead of an answer, keyed by the prompt file. */
  modelFailure?: Record<string, string>;
  /** Exit codes for the repository's own checks, keyed by pass. */
  checks?: Record<number, number>;
  /** What the repository's own checks print, keyed by pass. */
  checkOutput?: Record<number, string>;
  /** Exit code for the harness, keyed by the prompt file it was given. */
  harnessExit?: Record<string, number>;
  /** Tree hash per implementing pass, so oscillation can be forced. */
  hashes?: string[];
  /**
   * How long a harness pass takes, in fake milliseconds.
   *
   * The default guest answers instantly, which is what most of these tests
   * want and is exactly wrong for the lease: nothing that finishes inside one
   * tick is ever alive long enough to renew anything.
   */
  slowHarnessMs?: number;
  /**
   * Stdout the first implementing pass writes while it runs, before it exits,
   * and a hook called once it has been written. Without it the fake harness
   * gives its output only with its result, as a runtime that cannot stream.
   */
  streamed?: { stdout: string; whileRunning: () => void };
  /**
   * The first implementing pass streams a paid message and is then stopped at
   * the deadline, the way the runtime aborts it: by throwing.
   */
  stoppedAfterSpending?: boolean;
  /** What packing the tree for the push answers, when not plain success. */
  packed?: { exitCode: number; stderr: string };
  /** The outbox as it stands after each implementing pass, keyed by pass. */
  outbox?: Record<number, string>;
}

function buildGuest(script: GuestScript) {
  const commands: string[] = [];
  const files = new Map<string, string>();
  let implementPasses = 0;
  let reviewPasses = 0;

  const firstGeneration = generation;
  const sandbox: SandboxHandle & { disposed: boolean } = {
    id: RUN,
    tier: 'microvm',
    disposed: false,

    async exec(command: string, options?: SandboxExecOptions) {
      commands.push(command);

      const ok = { exitCode: 0, stdout: '', stderr: '', egressDenied: 0 };

      const prompt =
        /\/workspace\/(prompt\.md|revise-\d+\.md|review-\d+\.md)/.exec(
          command,
        )?.[1];

      if (prompt) {
        if (script.slowHarnessMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, script.slowHarnessMs),
          );
        }

        const exitCode = script.harnessExit?.[prompt] ?? 0;
        const refusal = script.modelFailure?.[prompt];

        if (refusal !== undefined) {
          if (prompt.startsWith('review-')) {
            reviewPasses += 1;
          } else {
            implementPasses += 1;
          }

          return { ...ok, exitCode: 0, stdout: piRefusal(refusal) };
        }

        if (prompt.startsWith('review-')) {
          reviewPasses += 1;
          const pass = Number(/review-(\d+)\.md/.exec(prompt)?.[1]);
          const verdict = script.verdicts[pass];

          if (verdict !== undefined) {
            files.set(`review-${pass}.json`, verdict);
          }

          return { ...ok, exitCode, stdout: piOutput('Reviewed it.') };
        }

        implementPasses += 1;

        if (
          script.stoppedAfterSpending &&
          implementPasses === 1 &&
          options?.onStdout
        ) {
          options.onStdout(`${piOutput('Working on it.')}\n`);
          throw new Error('The sandbox deadline passed.');
        }

        if (script.streamed && implementPasses === 1 && options?.onStdout) {
          // Split inside a line, as a pipe can.
          const { stdout, whileRunning } = script.streamed;
          const middle = Math.floor(stdout.length / 2);
          options.onStdout(stdout.slice(0, middle));
          options.onStdout(stdout.slice(middle));
          await new Promise((resolve) => setImmediate(resolve));
          whileRunning();

          return { ...ok, exitCode, stdout };
        }

        return {
          ...ok,
          exitCode,
          stdout: piOutput(`Did pass ${implementPasses}.`),
        };
      }

      if (command.includes('vantik-outbox.jsonl')) {
        return { ...ok, stdout: script.outbox?.[implementPasses] ?? '' };
      }

      if (command.startsWith('tar czf') && script.packed) {
        return { ...ok, ...script.packed };
      }

      if (command.includes('tree-tools.sh hash')) {
        const hash =
          script.hashes?.[implementPasses - 1] ??
          `${'a'.repeat(31)}${implementPasses}`;
        return { ...ok, stdout: `${hash}\n` };
      }

      if (command.includes('pnpm test')) {
        return {
          ...ok,
          exitCode: script.checks?.[implementPasses] ?? 0,
          stdout: script.checkOutput?.[implementPasses] ?? 'ran the suite',
        };
      }

      return ok;
    },

    ...(script.billedPerCall !== undefined
      ? {
          async modelCalls(since: number) {
            // Every call the harness has reported so far was metered.
            const calls = Array.from(
              { length: generation - since - firstGeneration },
              (_, index) => {
                const seq = since + index;
                return {
                  seq,
                  host: 'openrouter.ai',
                  api: 'openai-chat' as const,
                  status: 200,
                  startedAt: 0,
                  durationMs: 1,
                  responseId: `gen-${firstGeneration + seq + 1}`,
                  costUsd: script.billedPerCall,
                };
              },
            );
            return { calls, next: generation - firstGeneration };
          },
        }
      : {}),

    async readFile(path: string) {
      const held = files.get(path);

      if (held === undefined) {
        // Matches the runtime: reading a file the guest never wrote throws.
        throw new Error(`no such file: ${path}`);
      }

      return held;
    },

    async writeFile(path: string, contents: string) {
      files.set(path, contents);
    },

    async dispose() {
      sandbox.disposed = true;
    },
  };

  // `tree.b64` is read after the tree is packed; the fake guest always has one.
  files.set('tree.b64', Buffer.from('tree').toString('base64'));

  return {
    sandbox,
    commands,
    files,
    passes: () => ({ implement: implementPasses, review: reviewPasses }),
  };
}

function build(
  script: GuestScript,
  config: Record<string, unknown> = {},
  options: { leaseHeld?: boolean; nothingPushed?: boolean } = {},
) {
  const guest = buildGuest(script);
  const specs: SandboxSpec[] = [];

  const transitions: Array<{ status: string; patch: Record<string, unknown> }> =
    [];
  const iterations: Array<Record<string, unknown>> = [];
  const events: Array<{ message: string; phase?: string }> = [];
  const handbacks: Array<Record<string, unknown>> = [];
  const spends: Array<{ costUsd: number; turns: number }> = [];

  const agentRuns = {
    transition: jest.fn(async (_id: string, status: string, patch = {}) => {
      transitions.push({ status, patch });
    }),
    renewLease: jest.fn(async () => options.leaseHeld ?? true),
    appendEvent: jest.fn(async (_id: string, event: never) => {
      events.push(event);
    }),
    recordIteration: jest.fn(async (_id: string, input: never) => {
      iterations.push(input);
    }),
    delegator: jest.fn(async (): Promise<null> => null),
    recordSpend: jest.fn(
      async (_id: string, spent: { costUsd: number; turns: number }) => {
        spends.push(spent);
      },
    ),
  };

  // The real outbox service over fake writers, so these tests hold the
  // checks in run-outbox.ts to what the executor actually feeds them.
  const vantikWrites = {
    notes: [] as string[],
    facts: [] as string[],
    ticks: [] as string[],
  };
  const questions = {
    create: jest.fn(async (): Promise<unknown> => ({})),
    undelivered: jest.fn(async (): Promise<unknown[]> => []),
    markDelivered: jest.fn(async (): Promise<void> => undefined),
  };
  const outbox = new RunOutboxService(
    {
      createIssueComment: jest.fn(
        async (_p: unknown, _u: unknown, body: { bodyMarkdown: string }) => {
          vantikWrites.notes.push(body.bodyMarkdown);
        },
      ),
    } as never,
    {
      createEntry: jest.fn(
        async (_p: unknown, _w: unknown, data: { content: string }) => {
          vantikWrites.facts.push(data.content);
        },
      ),
    } as never,
    {
      updateChecklistItem: jest.fn(
        async (params: { checklistItemId: string }) => {
          vantikWrites.ticks.push(params.checklistItemId);
        },
      ),
    } as never,
    questions as never,
  );

  const pushWorkTree = jest.fn(async (request: { summary: string }) => {
    void request;
    // The proxy answers null when the tree matches the base: nothing to push.
    return options.nothingPushed
      ? null
      : {
          branch: 'agent/eng-42',
          headCommit: 'head111',
          delivery: 'pull_request',
          prUrl: 'https://example.test/pr/1',
        };
  });

  const executor = new HostedExecutor(
    { register: jest.fn() } as never,
    {
      create: jest.fn(async (spec: SandboxSpec) => {
        specs.push(spec);
        return guest.sandbox;
      }),
    } as never,
    {
      revealModelKey: jest.fn(async () => ({
        provider: 'anthropic',
        secret: 'sk-ant-secret',
        baseUrl: null as string | null,
      })),
    } as never,
    {
      materializeCheckout: jest.fn(async () => ({
        archiveBase64: 'YXJjaGl2ZQ==',
        baseCommit: 'base000',
        baseBranch: 'main',
      })),
      pushWorkTree,
    } as never,
    {
      post: jest.fn(async (...args: unknown[]) => {
        handbacks.push(args[3] as Record<string, unknown>);
      }),
    } as never,
    agentRuns as never,
    outbox as never,
    questions as never,
  );

  const run = {
    createdById: 'person-1',
    id: RUN,
    workspaceId: WORKSPACE,
    issueId: 'issue-1',
    agentUserId: 'agent-1',
    attempt: 1,
    config: {
      source: {
        integrationAccountId: 'account-1',
        externalRepoId: '123',
        fullName: 'acme/app',
      },
      testCommand: 'pnpm test',
      harnessCommand: 'fake-harness',
      ...config,
    },
    contextPack: {
      version: 1,
      issue: { key: 'ENG-42', title: 'Keep the last row', description: 'x' },
      definitionOfDone: [
        { id: 'c1', body: 'Keeps the last row', completed: false },
      ],
      repo: { testCommand: 'pnpm test' },
    },
  };

  const execute = () =>
    (executor as unknown as { execute(run: unknown): Promise<void> }).execute(
      run,
    );

  return {
    execute,
    executor,
    agentRuns,
    guest,
    specs,
    /** What the pull request body said, which is what a reviewer opens. */
    prBody: () => pushWorkTree.mock.calls[0]?.[0]?.summary ?? '',
    pushWorkTree,
    transitions,
    iterations,
    events,
    handbacks,
    spends,
    vantikWrites,
    questions,
    final: () => transitions[transitions.length - 1],
  };
}

const ACCEPTED = JSON.stringify({ accepted: true, findings: [] });

const REJECTED = JSON.stringify({
  accepted: false,
  summary: 'The off-by-one is still there.',
  findings: [
    {
      message: 'Loop still exits one short',
      evidence: 'src/importer.ts:88',
      severity: 'high',
      criterion: 1,
    },
  ],
});

describe('a run the reviewer accepts first time', () => {
  it('implements, checks, reviews, and succeeds', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(harness.guest.passes()).toEqual({ implement: 1, review: 1 });
    expect(harness.final().status).toBe('SUCCEEDED');
  });

  it('runs the repository’s own checks itself rather than believing the agent', async () => {
    // An agent that believes it ran the tests and did not is a common and
    // quiet failure, and the reviewer's whole grounding is that this result is
    // a fact rather than a claim.
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(
      harness.guest.commands.filter((command) => command.includes('pnpm test')),
    ).toHaveLength(1);
  });

  it('reviews in the same guest the work was done in', async () => {
    // A reviewer handed a copy could not run anything against what it is
    // reviewing, which is back to having an opinion about a diff.
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(harness.specs).toHaveLength(1);
  });

  it('gives the reviewer a different prompt and different skills', async () => {
    const harness = build(
      { verdicts: { 1: ACCEPTED } },
      // The bundled harness, so this reads the command the executor really
      // builds — which needs the model the run was dispatched with.
      { harnessCommand: undefined, model: 'claude-opus-5' },
    );

    await harness.execute();

    const implement = harness.guest.commands.find((command) =>
      command.includes('/workspace/prompt.md'),
    );
    const review = harness.guest.commands.find((command) =>
      command.includes('/workspace/review-1.md'),
    );

    expect(implement).toContain('--skill /workspace/skills/writing-code');
    expect(implement).not.toContain('reviewing-work');
    expect(review).toContain('--skill /workspace/skills/reviewing-work');
    expect(review).not.toContain('writing-code');
  });

  it('records the pass, which nothing used to write at all', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(harness.iterations).toHaveLength(1);
    expect(harness.iterations[0]).toMatchObject({
      index: 1,
      verificationPassed: true,
      findings: [],
    });
  });

  it('says on the pull request that a second agent read it', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(harness.prBody()).toContain('reviewed it against the issue');
    expect(harness.prBody()).not.toContain('Nothing signed this off');
  });

  it('leaves the pristine base tree out of what is delivered', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    const packed = harness.guest.commands.find((command) =>
      command.startsWith('tar czf'),
    );

    expect(packed).toContain('-C /workspace/repo');
    expect(packed).not.toContain('/workspace/base');
  });

  it('leaves installed dependencies and caches out of what is delivered', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    const packed = harness.guest.commands.find((command) =>
      command.startsWith('tar czf'),
    );

    // Setup installs into the checkout. A monorepo's node_modules packed into
    // one base64 string is past what V8 will build, and the run crashed at
    // the push with its work done.
    expect(packed).toContain('--exclude=node_modules');
    expect(packed).toContain('--exclude=.git ');
    expect(packed).toContain('--exclude=.venv');
    expect(packed).not.toContain('--exclude=dist');
  });

  it('fails a tree too large to read back, saying so, and pushes nothing', async () => {
    const harness = build({
      verdicts: { 1: ACCEPTED },
      packed: { exitCode: 3, stderr: 'the packed tree is 300000000 bytes\n' },
    });

    await harness.execute();

    expect(harness.final().status).toBe('FAILED');
    expect(harness.final().patch).toMatchObject({ failure: 'HARNESS_CRASHED' });
    expect(harness.final().patch.error).toContain(
      'too large to push: the packed tree is 300000000 bytes, over the 200 MB limit',
    );
    expect(harness.pushWorkTree).not.toHaveBeenCalled();
  });
});

describe('a run the reviewer sends back', () => {
  it('revises with the findings and reviews again', async () => {
    const harness = build({ verdicts: { 1: REJECTED, 2: ACCEPTED } });

    await harness.execute();

    expect(harness.guest.passes()).toEqual({ implement: 2, review: 2 });
    expect(harness.final().status).toBe('SUCCEEDED');
  });

  it('tells the next pass what to fix, and where', async () => {
    const harness = build({ verdicts: { 1: REJECTED, 2: ACCEPTED } });

    await harness.execute();

    const revision = harness.guest.files.get('revise-2.md') ?? '';

    expect(revision).toContain('Loop still exits one short');
    expect(revision).toContain('src/importer.ts:88');
    // The issue again, because this is a fresh process with no memory of the
    // first pass and one handed only findings drifts off the issue.
    expect(revision).toContain('ENG-42');
    expect(revision).toContain('1. Keeps the last row');
  });

  it('hands the failing check to the next pass as well as the findings', async () => {
    const harness = build({
      verdicts: { 1: REJECTED, 2: ACCEPTED },
      checks: { 1: 1 },
    });

    await harness.execute();

    expect(harness.guest.files.get('revise-2.md')).toContain(
      'Checks that are currently failing',
    );
    expect(harness.iterations[0]).toMatchObject({ verificationPassed: false });
  });

  it('[KG-3.4] records whether the reviewer accepted each pass, and the files a failing check failed in', async () => {
    // What a run's end is traced back to the knowledge it was handed by.
    const harness = build({
      verdicts: { 1: REJECTED, 2: ACCEPTED },
      checks: { 1: 1 },
      checkOutput: {
        1: 'FAIL /workspace/repo/src/importer.spec.ts\n  at readRows (src/importer.ts:88:3)',
      },
    });

    await harness.execute();

    expect(harness.iterations[0]).toMatchObject({
      accepted: false,
      failedChecks: [
        {
          label: expect.any(String),
          command: 'pnpm test',
          paths: ['src/importer.spec.ts', 'src/importer.ts'],
        },
      ],
    });
    expect(harness.iterations[1]).toMatchObject({
      accepted: true,
      failedChecks: [],
    });
  });

  it('records every pass separately', async () => {
    const harness = build({ verdicts: { 1: REJECTED, 2: ACCEPTED } });

    await harness.execute();

    expect(harness.iterations.map((entry) => entry.index)).toEqual([1, 2]);
  });
});

describe('a run nothing signs off', () => {
  it('stops at the pass ceiling and asks for a human', async () => {
    const harness = build(
      { verdicts: { 1: REJECTED, 2: REJECTED, 3: REJECTED } },
      { limits: { maxCycles: 3 } },
    );

    await harness.execute();

    expect(harness.guest.passes().review).toBe(3);
    expect(harness.final().status).toBe('NEEDS_REVIEW');
  });

  it('still delivers the branch, because the work is real', async () => {
    const harness = build(
      { verdicts: { 1: REJECTED } },
      { limits: { maxCycles: 1 } },
    );

    await harness.execute();

    expect(harness.final().patch).toMatchObject({
      result: expect.objectContaining({ branch: 'agent/eng-42' }),
    });
    expect(harness.handbacks[0]).toMatchObject({ status: 'NEEDS_REVIEW' });
  });

  it('stops when the money runs out', async () => {
    // Each fake invocation reports $0.50, so a ceiling of one dollar is spent
    // partway through the second pass.
    const harness = build(
      { verdicts: { 1: REJECTED, 2: REJECTED, 3: REJECTED } },
      { limits: { maxCostUsd: 1, maxCycles: 10 } },
    );

    await harness.execute();

    expect(harness.final().status).toBe('NEEDS_REVIEW');
    expect(harness.guest.passes().review).toBeLessThan(3);
  });

  it('stops when two passes in a row changed nothing', async () => {
    const harness = build(
      {
        verdicts: { 1: REJECTED, 2: REJECTED, 3: REJECTED },
        hashes: ['b'.repeat(32), 'b'.repeat(32), 'b'.repeat(32)],
      },
      { limits: { maxCycles: 10, maxCostUsd: 100 } },
    );

    await harness.execute();

    expect(harness.guest.passes().review).toBe(2);
    expect(harness.final().status).toBe('NEEDS_REVIEW');
  });

  it('never reads an unreadable verdict as acceptance', async () => {
    // "The reviewer did not answer" and "the reviewer said yes" must not
    // collapse into the same outcome, because one of them ships unreviewed work
    // as a success.
    const harness = build({ verdicts: { 1: 'the diff looks fine to me' } });

    await harness.execute();

    expect(harness.final().status).toBe('NEEDS_REVIEW');
  });

  it('never reads a missing verdict as acceptance', async () => {
    const harness = build({ verdicts: {} });

    await harness.execute();

    expect(harness.final().status).toBe('NEEDS_REVIEW');
  });

  it('refuses to accept a tree whose checks are failing', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED }, checks: { 1: 1 } });

    await harness.execute();

    expect(harness.final().status).toBe('NEEDS_REVIEW');
  });

  it('says what the reviewer still objected to, on the issue and on the PR', async () => {
    // "Why it stopped" tells a person the budget ran out. This tells them what
    // to go and look at, which is the whole reason the run is theirs now — and
    // it is on the pull request too, because whoever opens that from the git
    // host never sees the issue comment.
    const harness = build(
      { verdicts: { 1: REJECTED } },
      { limits: { maxCycles: 1 } },
    );

    await harness.execute();

    for (const text of [
      harness.prBody(),
      String(harness.handbacks[0].summary),
    ]) {
      expect(text).toContain('Loop still exits one short');
      expect(text).toContain('src/importer.ts:88');
      expect(text).toContain('The off-by-one is still there.');
    }
  });

  it('does not list findings on a run that was accepted', async () => {
    // Nothing is outstanding, and a "still open" heading over an empty list
    // reads as though the reviewer had reservations it did not state.
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(harness.prBody()).not.toContain('Still open');
    expect(String(harness.handbacks[0].summary)).not.toContain('Still open');
  });

  it('does not claim the reviewer found nothing when it said nothing', async () => {
    // A silent reviewer leaves no findings, and a "still open" heading with an
    // empty list under it would say the diff was read and passed.
    const harness = build({ verdicts: { 1: 'not json' } });

    await harness.execute();

    expect(harness.prBody()).toContain('Nothing signed this off');
    expect(harness.prBody()).not.toContain('Still open');
  });

  it('says on the pull request that nothing signed it off', async () => {
    // "An agent wrote this" and "an agent wrote this and a second agent signed
    // it off" call for different amounts of attention from whoever opens it.
    const harness = build({ verdicts: {} }, { limits: { maxCycles: 1 } });

    await harness.execute();

    expect(harness.prBody()).toContain('Nothing signed this off');
    expect(harness.handbacks[0]).toMatchObject({ status: 'NEEDS_REVIEW' });
    expect(String(harness.handbacks[0].summary)).toContain('reviewer');
  });
});

/**
 * The harness exits zero when the provider refuses it, so a run whose model
 * never answered used to look like a pass that did the work and had nothing to
 * report. It then spent its budget on passes that could not do anything and
 * finished by blaming the reviewer for producing no verdict.
 */
describe('when the model never answers', () => {
  const REFUSED =
    '400: {"message":"google/gemini-nope is not a valid model ID","code":400}';

  it('fails the run rather than reading it as a pass that did nothing', async () => {
    const harness = build({
      verdicts: {},
      modelFailure: { 'prompt.md': REFUSED },
    });

    await harness.execute();

    expect(harness.final().status).toBe('FAILED');
  });

  it('says the model refused, not that the reviewer was silent', async () => {
    const harness = build({
      verdicts: {},
      modelFailure: { 'prompt.md': REFUSED },
    });

    await harness.execute();

    const error = JSON.stringify(harness.final());

    expect(error).toContain('is not a valid model ID');
    expect(error).not.toContain('verdict');
  });

  it('never asks a reviewer to read a diff that was never written', async () => {
    const harness = build({
      verdicts: {},
      modelFailure: { 'prompt.md': REFUSED },
    });

    await harness.execute();

    expect(harness.guest.passes()).toEqual({ implement: 1, review: 0 });
  });

  it('delivers the earlier passes when a later one loses the model', async () => {
    const harness = build({
      verdicts: { 1: REJECTED },
      modelFailure: { 'revise-2.md': REFUSED },
    });

    await harness.execute();

    // The work from pass one is real and is handed to a human, exactly as it
    // is when a later pass crashes outright.
    expect(harness.final().status).toBe('NEEDS_REVIEW');
    expect(harness.prBody()).toContain('Nothing signed this off');
  });

  it('still destroys the guest', async () => {
    const harness = build({
      verdicts: {},
      modelFailure: { 'prompt.md': REFUSED },
    });

    await harness.execute();

    expect(harness.guest.sandbox.disposed).toBe(true);
  });

  it('files it as a refusal, with the provider’s sentence rather than its body', async () => {
    const harness = build({
      verdicts: {},
      modelFailure: {
        'prompt.md':
          '402 {"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402,"metadata":{"provider_name":null}}}',
      },
    });

    await harness.execute();

    expect(harness.final().patch).toMatchObject({
      failure: 'MODEL_REFUSED',
      error: '402: This request requires more credits, or fewer max_tokens.',
    });
  });

  it('says the provider refused the reviewer, rather than that the reviewer was silent', async () => {
    const harness = build({
      verdicts: {},
      modelFailure: { 'review-1.md': '429: {"message":"rate limited"}' },
    });

    await harness.execute();

    expect(harness.final().status).toBe('NEEDS_REVIEW');
    const summary = String(harness.handbacks[0].summary);
    expect(summary).toContain('refused the reviewer');
    expect(summary).toContain('429: rate limited');
    // Another pass would be refused the same way.
    expect(harness.guest.passes()).toEqual({ implement: 1, review: 1 });
  });
});

/**
 * Pi has a default model and would use it happily. A run that fell back to it
 * would put the work on a model nobody picked, bill it to whoever configured
 * the key, and make "which model wrote this diff" unanswerable from the row.
 */
describe('the model the run was dispatched with', () => {
  it('refuses a run that named none, rather than taking the harness’s default', async () => {
    const harness = build(
      { verdicts: { 1: ACCEPTED } },
      { harnessCommand: undefined, model: undefined },
    );

    await harness.execute();

    expect(harness.final().status).toBe('FAILED');
    expect(JSON.stringify(harness.final())).toContain('named no model');
  });

  it('refuses an id it could not pass on safely', async () => {
    // `piCommand` drops an unsafe id rather than quoting it, so letting this
    // through would land on the harness's default too.
    const harness = build(
      { verdicts: { 1: ACCEPTED } },
      { harnessCommand: undefined, model: 'opus; rm -rf /' },
    );

    await harness.execute();

    expect(harness.final().status).toBe('FAILED');
  });

  it('never boots a guest for a run it is going to refuse', async () => {
    const harness = build(
      { verdicts: { 1: ACCEPTED } },
      { harnessCommand: undefined, model: undefined },
    );

    await harness.execute();

    expect(harness.specs).toHaveLength(0);
  });

  it('leaves a deployment’s own harness to make its own choice', async () => {
    // The model is not passed to a configured command, so requiring one would
    // refuse a setup that is working.
    const harness = build({ verdicts: { 1: ACCEPTED } }, { model: undefined });

    await harness.execute();

    expect(harness.final().status).toBe('SUCCEEDED');
  });
});

describe('when a pass crashes', () => {
  it('fails the run when the first pass crashed, because there is nothing to show', async () => {
    const harness = build({
      verdicts: {},
      harnessExit: { 'prompt.md': 1 },
    });

    await harness.execute();

    expect(harness.final().status).toBe('FAILED');
    expect(harness.final().patch).toMatchObject({ failure: 'HARNESS_CRASHED' });
  });

  it('[KG-3.6] says what a failed run spent, so the arms compare what runs cost', async () => {
    // Each fake pass reports $0.50. Leaving a failed run's spend out would
    // make whichever arm fails expensively look cheap.
    const crashed = build({ verdicts: {}, harnessExit: { 'prompt.md': 1 } });
    await crashed.execute();
    expect(crashed.final().patch).toMatchObject({
      failure: 'HARNESS_CRASHED',
      result: { costUsd: 0.5 },
    });

    const empty = build(
      { verdicts: { 1: ACCEPTED } },
      {},
      { nothingPushed: true },
    );
    await empty.execute();
    expect(empty.final().patch).toMatchObject({
      failure: 'NO_DIFF_PRODUCED',
      // One implementing pass and one review.
      result: { costUsd: 1 },
    });
  });

  it('counts what a pass spent before the deadline stopped it', async () => {
    const harness = build({ verdicts: {}, stoppedAfterSpending: true });

    await harness.execute();

    expect(harness.final().patch).toMatchObject({
      failure: 'HARNESS_CRASHED',
      result: { costUsd: 0.5, turns: 1 },
    });
  });

  it('keeps the spend on the run as it grows, and in the final result', async () => {
    // Each fake pass reports $0.50 over one turn. A person watching the run
    // sees it climb pass by pass rather than learning the total at the end.
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(harness.spends).toEqual([
      { costUsd: 0.5, turns: 1 },
      { costUsd: 1, turns: 2 },
    ]);
    expect(harness.final().patch).toMatchObject({
      result: { costUsd: 1, turns: 2 },
    });
  });

  it('counts each call at what the provider billed, when the sandbox host metered it', async () => {
    // The harness prices each pass at $0.50 from its catalog; the gateway
    // billed $0.70.
    const harness = build({ verdicts: { 1: ACCEPTED }, billedPerCall: 0.7 });

    await harness.execute();

    expect(harness.spends).toEqual([
      { costUsd: 0.7, turns: 1 },
      { costUsd: 1.4, turns: 2 },
    ]);
    expect(harness.final().patch).toMatchObject({
      result: { costUsd: 1.4, turns: 2 },
    });
  });

  it('delivers what the earlier passes built when a later one crashes', async () => {
    // Throwing away two passes of real work to report the third one's exit
    // code helps nobody.
    const harness = build({
      verdicts: { 1: REJECTED },
      harnessExit: { 'revise-2.md': 1 },
    });

    await harness.execute();

    expect(harness.final().status).toBe('NEEDS_REVIEW');
    expect(harness.final().patch).toMatchObject({
      result: expect.objectContaining({ branch: 'agent/eng-42' }),
    });
  });
});

describe('with reviewing turned off', () => {
  const off = { phases: { review: false } };

  it('does exactly one pass and no review', async () => {
    const harness = build({ verdicts: {} }, off);

    await harness.execute();

    expect(harness.guest.passes()).toEqual({ implement: 1, review: 0 });
    expect(harness.final().status).toBe('SUCCEEDED');
  });

  it('does not pay for a second copy of the tree', async () => {
    const harness = build({ verdicts: {} }, off);

    await harness.execute();

    expect(harness.specs[0].files).not.toHaveProperty('tree-tools.sh');
    expect(
      harness.guest.commands.find((command) => command.startsWith('mkdir -p')),
    ).not.toContain('/workspace/base');
  });
});

describe('whatever happens', () => {
  it('starts a brand new guest and destroys it at the end', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(harness.specs).toHaveLength(1);
    expect(harness.specs[0].runId).toBe(RUN);
    expect(harness.guest.sandbox.disposed).toBe(true);
  });

  it('destroys the guest even when the run failed', async () => {
    const harness = build({ verdicts: {}, harnessExit: { 'prompt.md': 1 } });

    await harness.execute();

    expect(harness.guest.sandbox.disposed).toBe(true);
  });

  it('keeps the model key out of the guest’s plain environment', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    expect(JSON.stringify(harness.specs[0].env)).not.toContain('sk-ant-secret');
    expect(harness.specs[0].secrets.ANTHROPIC_API_KEY.hosts).toEqual([
      'api.anthropic.com',
    ]);
  });

  it('puts each step on the timeline while the harness still runs', async () => {
    const step = (path: string) =>
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: path,
        toolName: 'read',
        args: { path },
      });
    let seenWhileRunning: string[] = [];

    const harness = build({
      verdicts: { 1: ACCEPTED },
      streamed: {
        stdout: `${step('src/a.ts')}\n${step('src/b.ts')}\n${piOutput('Done.')}`,
        whileRunning: () => {
          seenWhileRunning = harness.events.map((event) => event.message);
        },
      },
    });

    await harness.execute();

    expect(seenWhileRunning).toEqual(
      expect.arrayContaining(['read: src/a.ts', 'read: src/b.ts']),
    );
    // Once each: the result's copy of the same output is not read again.
    expect(
      harness.events.filter((event) => event.message === 'read: src/a.ts'),
    ).toHaveLength(1);
  });

  it('groups each pass under its own heading in the timeline', async () => {
    // Grouping on the bare name drew pass two's edits above pass one's review
    // and made every "Reviewed the work" heading the same heading.
    const harness = build({ verdicts: { 1: REJECTED, 2: ACCEPTED } });

    await harness.execute();

    const phases = new Set(harness.events.map((event) => event.phase));

    expect(phases).toContain('implement');
    expect(phases).toContain('verify');
    expect(phases).toContain('review');
    expect(phases).toContain('revise-2');
    expect(phases).toContain('review-2');
  });
});

/**
 * A hosted run is an unawaited promise in this process, so nothing outside it
 * knows whether it is alive. The lease is how it says so, and these are the
 * two ends of that: it takes one when it claims the work, and it stops when
 * the server tells it the run is no longer its to do.
 */
describe('a run is answerable for its own liveness', () => {
  it('claims with a lease, so the sweeper can see it at all', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.execute();

    const claim = harness.transitions.find(
      (transition) => transition.status === 'CLAIMED',
    );

    // Without this the sweeper's predicate — a lease that exists and has
    // lapsed — never matches a hosted run, and the one backend that ships is
    // the one nothing can reap.
    expect(claim?.patch.leaseExpiresAt).toBeInstanceOf(Date);
    expect((claim?.patch.leaseExpiresAt as Date).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('renews it while the work is going, and stops when the work does', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });

    try {
      const harness = build({
        verdicts: { 1: ACCEPTED },
        slowHarnessMs: 10 * 60 * 1000,
      });
      const finished = harness.execute();

      // Far enough for several renewals of a five-minute lease.
      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
      await finished;

      expect(harness.agentRuns.renewLease).toHaveBeenCalled();

      // A timer nobody cleared holds this run's id in the event loop long
      // after the sandbox is gone, renewing a lease on a finished run.
      const renewals = harness.agentRuns.renewLease.mock.calls.length;
      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(harness.agentRuns.renewLease).toHaveBeenCalledTimes(renewals);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops the guest when the lease turns out not to be its any more', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });

    try {
      // The sweeper won the race: this run is EXPIRED and a fresh attempt is
      // already going. Carrying on would spend the model budget twice for one
      // result, so losing the lease has to actually stop the machine.
      const harness = build(
        { verdicts: { 1: ACCEPTED }, slowHarnessMs: 10 * 60 * 1000 },
        {},
        { leaseHeld: false },
      );
      const finished = harness.execute();

      // Only far enough for a renewal to be refused, and nowhere near far
      // enough for the ten-minute harness pass to end. Asserting after the run
      // finished would prove nothing: the guest is disposed in `finally` on
      // every path, so the whole question is whether it goes *early*.
      await jest.advanceTimersByTimeAsync(4 * 60 * 1000);

      expect(harness.guest.sandbox.disposed).toBe(true);

      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
      await finished;
    } finally {
      jest.useRealTimers();
    }
  });

  it('touches nothing on boot', async () => {
    // This replaced a reconcile that failed every hosted run in CLAIMED or
    // RUNNING across the deployment. On two replicas each booting one killed
    // the other's live work, so a rolling deploy told the user to retry runs
    // that were still going. Booting now registers the backend and stops.
    const harness = build({ verdicts: { 1: ACCEPTED } });

    await harness.executor.onModuleInit();

    expect(harness.transitions).toEqual([]);
  });
});

describe('what the agent writes to Vantik from the sandbox', () => {
  const OUTBOX = [
    {
      v: 1,
      type: 'note',
      body: 'The importer drops the last row on a short page.',
    },
    {
      v: 1,
      type: 'remember',
      content: 'Rows are paged by 500.',
      citations: [{ path: 'src/importer.ts', lines: '80-90' }],
    },
    {
      v: 1,
      type: 'criterion',
      id: 'c1',
      evidence: 'importer.spec keeps the last row',
    },
    { v: 1, type: 'criterion', id: 'someone-elses', evidence: 'trust me' },
  ]
    .map((item) => JSON.stringify(item))
    .concat('not json')
    .join('\n')
    .concat('\n');

  it('posts notes and proposes facts after the pass, and ticks a criterion once the run succeeds', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED }, outbox: { 1: OUTBOX } });

    await harness.execute();

    expect(harness.final().status).toBe('SUCCEEDED');
    expect(harness.vantikWrites).toEqual({
      notes: ['The importer drops the last row on a short page.'],
      facts: ['Rows are paged by 500.'],
      ticks: ['c1'],
    });
    const said = harness.events.map((e) => e.message);
    expect(said).toContainEqual(
      expect.stringContaining(
        'refused 2 lines of the outbox (not a criterion of this issue, not JSON)',
      ),
    );
    expect(said).toContainEqual(expect.stringContaining('ticked 1 criterion'));
  });

  it('does not tick a criterion on a run nobody signed off', async () => {
    const harness = build({ verdicts: {}, outbox: { 1: OUTBOX } });

    await harness.execute();

    expect(harness.final().status).toBe('NEEDS_REVIEW');
    expect(harness.vantikWrites.ticks).toEqual([]);
    expect(harness.vantikWrites.notes).toHaveLength(1);
  });
});

describe('questions to a person from the sandbox', () => {
  const ask = (id: string, questions: unknown) =>
    `${JSON.stringify({ v: 1, type: 'question', id, questions })}\n`;
  const ITEMS = [{ id: 'q', prompt: 'Which?' }];

  it('opens the question for the person who started the run', async () => {
    const harness = build({
      verdicts: { 1: ACCEPTED },
      outbox: { 1: ask('ask-1', ITEMS) },
    });

    await harness.execute();

    expect(harness.questions.create).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'ask-1', assigneeId: 'person-1' }),
    );
  });

  it('tells the tool when Vantik refuses a question, so it stops waiting', async () => {
    const harness = build({
      verdicts: { 1: ACCEPTED },
      outbox: { 1: ask('ask-1', ITEMS) },
    });
    harness.questions.create.mockRejectedValue(
      new RangeError('A run may ask 5 questions.'),
    );

    await harness.execute();

    const file = JSON.parse(harness.guest.files.get('answers/ask-1.json')!);
    expect(file).toMatchObject({
      status: 'cancelled',
      reason: 'A run may ask 5 questions.',
    });
  });

  it('tells the tool about a line that failed the checks', async () => {
    const harness = build({
      verdicts: { 1: ACCEPTED },
      outbox: { 1: ask('ask-2', [{ id: 'q' }]) },
    });

    await harness.execute();

    expect(harness.questions.create).not.toHaveBeenCalled();
    expect(harness.guest.files.get('answers/ask-2.json')).toContain('cancelled');
  });

  it('writes an answer again when its file did not reach the guest', async () => {
    const harness = build({ verdicts: { 1: ACCEPTED }, outbox: { 1: ask('ask-3', ITEMS) } });
    harness.questions.undelivered.mockResolvedValue([
      {
        id: 'aq3',
        agentRunId: RUN,
        externalId: 'ask-3',
        source: 'tool',
        status: 'ANSWERED',
        questions: ITEMS,
        answers: [{ id: 'q', selected: [], other: 'B' }],
      },
    ]);

    await harness.execute();

    expect(harness.guest.files.get('answers/ask-3.json')).toContain('answered');
    expect(harness.questions.markDelivered).toHaveBeenCalledWith('aq3');
  });
});
