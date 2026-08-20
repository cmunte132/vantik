import type { SandboxHandle, SandboxSpec } from '../sandbox/sandbox.interface';

import { HostedExecutor } from './hosted.executor';

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
function piOutput(summary: string): string {
  return [
    JSON.stringify({ type: 'turn_end' }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
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
  /** Verdict JSON per pass, keyed by pass number. Absent means no file. */
  verdicts: Record<number, string | undefined>;
  /** A model refusal instead of an answer, keyed by the prompt file. */
  modelFailure?: Record<string, string>;
  /** Exit codes for the repository's own checks, keyed by pass. */
  checks?: Record<number, number>;
  /** Exit code for the harness, keyed by the prompt file it was given. */
  harnessExit?: Record<string, number>;
  /** Tree hash per implementing pass, so oscillation can be forced. */
  hashes?: string[];
}

function buildGuest(script: GuestScript) {
  const commands: string[] = [];
  const files = new Map<string, string>();
  let implementPasses = 0;
  let reviewPasses = 0;

  const sandbox: SandboxHandle & { disposed: boolean } = {
    id: RUN,
    tier: 'microvm',
    disposed: false,

    async exec(command: string) {
      commands.push(command);

      const ok = { exitCode: 0, stdout: '', stderr: '', egressDenied: 0 };

      const prompt =
        /\/workspace\/(prompt\.md|revise-\d+\.md|review-\d+\.md)/.exec(
          command,
        )?.[1];

      if (prompt) {
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
        return {
          ...ok,
          exitCode,
          stdout: piOutput(`Did pass ${implementPasses}.`),
        };
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
          stdout: 'ran the suite',
        };
      }

      return ok;
    },

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

function build(script: GuestScript, config: Record<string, unknown> = {}) {
  const guest = buildGuest(script);
  const specs: SandboxSpec[] = [];

  const transitions: Array<{ status: string; patch: Record<string, unknown> }> =
    [];
  const iterations: Array<Record<string, unknown>> = [];
  const events: Array<{ message: string; phase?: string }> = [];
  const handbacks: Array<Record<string, unknown>> = [];

  const agentRuns = {
    transition: jest.fn(async (_id: string, status: string, patch = {}) => {
      transitions.push({ status, patch });
    }),
    appendEvent: jest.fn(async (_id: string, event: never) => {
      events.push(event);
    }),
    recordIteration: jest.fn(async (_id: string, input: never) => {
      iterations.push(input);
    }),
  };

  const pushWorkTree = jest.fn(async (request: { summary: string }) => {
    void request;
    return {
      branch: 'agent/eng-42',
      headCommit: 'head111',
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
      })),
      pushWorkTree,
    } as never,
    {
      post: jest.fn(async (...args: unknown[]) => {
        handbacks.push(args[3] as Record<string, unknown>);
      }),
    } as never,
    agentRuns as never,
    {} as never,
  );

  const run = {
    id: RUN,
    workspaceId: WORKSPACE,
    issueId: 'issue-1',
    agentUserId: 'agent-1',
    attempt: 1,
    config: {
      repoUrl: 'https://git.test/acme/app.git',
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
    guest,
    specs,
    /** What the pull request body said, which is what a reviewer opens. */
    prBody: () => pushWorkTree.mock.calls[0]?.[0]?.summary ?? '',
    transitions,
    iterations,
    events,
    handbacks,
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
