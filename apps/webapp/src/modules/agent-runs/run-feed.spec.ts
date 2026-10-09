import { describe, expect, it } from 'vitest';

import {
  FILTERS,
  type Step,
  changesOf,
  diffLines,
  matches,
  phrase,
  stagesOf,
  toFeed,
  toSteps,
  pullNumber,
} from './run-feed';
import { costOf, formatCost, phaseLabel, phaseRank } from './run-vocabulary';

/**
 * The two transformations that make a run readable.
 *
 * Both need the events in order, and both are the difference between a
 * timeline and the log it replaced — so they are tested here rather than left
 * to be judged by eye on a screen that only shows one run at a time.
 */

const event = (
  id: string,
  message: string,
  data?: Record<string, unknown>,
  level = 'INFO',
) => ({ id, message, level, phase: 'implement', data });

describe('toSteps', () => {
  it('merges adjacent reads into one row that counts them', () => {
    const steps = toSteps([
      event('1', 'read: a/repo-routing.ts', {
        kind: 'read',
        target: 'a/repo-routing.ts',
      }),
      event('2', 'read: a/context-pack.ts', {
        kind: 'read',
        target: 'a/context-pack.ts',
      }),
      event('3', 'read: a/sandbox.ts', {
        kind: 'read',
        target: 'a/sandbox.ts',
      }),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0].count).toBe(3);
    expect(steps[0].targets).toEqual([
      'a/repo-routing.ts',
      'a/context-pack.ts',
      'a/sandbox.ts',
    ]);
    expect(phrase(steps[0])).toBe('Read 3 files');
  });

  it('never merges a write, because a write is the point', () => {
    const steps = toSteps([
      event('1', 'write: one.ts', { kind: 'write', target: 'one.ts' }),
      event('2', 'write: two.ts', { kind: 'write', target: 'two.ts' }),
    ]);

    expect(steps).toHaveLength(2);
    expect(phrase(steps[0])).toBe('Wrote one.ts');
  });

  it('does not merge across a change of kind', () => {
    const steps = toSteps([
      event('1', 'read: one.ts', { kind: 'read', target: 'one.ts' }),
      event('2', 'grep: SLUG', { kind: 'search', target: 'SLUG' }),
      event('3', 'read: two.ts', { kind: 'read', target: 'two.ts' }),
    ]);

    expect(steps.map((step: Step) => step.kind)).toEqual([
      'read',
      'search',
      'read',
    ]);
  });

  it('folds an outcome back into the step it ended rather than adding a row', () => {
    const steps = toSteps([
      event('1', 'bash: pnpm exec jest', {
        kind: 'test',
        ref: 'call_7',
        command: 'pnpm exec jest',
      }),
      event(
        '2',
        'bash failed',
        {
          kind: 'bash',
          ref: 'call_7',
          ok: false,
          exit: 1,
          output: "Cannot find module '.prisma/client'",
        },
        'ERROR',
      ),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0].failed).toBe(true);
    expect(steps[0].exit).toBe(1);
    expect(steps[0].output).toBe("Cannot find module '.prisma/client'");
    // The start event decided this was a test run; the outcome must not
    // downgrade it to a plain bash call.
    expect(phrase(steps[0])).toBe('Tests failed');
  });

  it('counts a passing test run into the step that ran it', () => {
    const steps = toSteps([
      event('1', 'bash: pnpm exec jest', {
        kind: 'test',
        ref: 'call_9',
        command: 'pnpm exec jest',
      }),
      event('2', 'Tests passed: 6', {
        kind: 'test',
        ref: 'call_9',
        ok: true,
        passed: 6,
      }),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0].failed).toBe(false);
    expect(steps[0].passed).toBe(6);
    expect(phrase(steps[0])).toBe('Tests passed');
  });

  it('keeps a failure whose start it never saw, rather than swallowing it', () => {
    // An outcome with no matching ref is all the reader has. Dropping it would
    // lose the only record that something broke.
    const steps = toSteps([
      event(
        '1',
        'bash failed',
        { kind: 'bash', ref: 'gone', ok: false },
        'ERROR',
      ),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0].failed).toBe(true);
  });

  it('renders an event with no kind as its plain message', () => {
    // Older runs carry no data at all, and a newer harness may report a kind
    // this bundle has never heard of. Neither may produce a blank timeline.
    const steps = toSteps([
      event('1', 'Compacting the context'),
      event('2', 'Something new happened', { kind: 'telepathy' }),
    ]);

    expect(steps).toHaveLength(2);
    expect(phrase(steps[0])).toBe('Compacting the context');
    expect(phrase(steps[1])).toBe('Something new happened');
  });

  it('does not merge into a step that already failed', () => {
    // Otherwise a failed read collects the reads after it and the row claims a
    // count that includes work that went fine.
    const steps = toSteps([
      event('1', 'read: one.ts', { kind: 'read', ref: 'a', target: 'one.ts' }),
      event('2', 'read failed', { kind: 'read', ref: 'a', ok: false }, 'ERROR'),
      event('3', 'read: two.ts', { kind: 'read', target: 'two.ts' }),
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0].count).toBe(1);
    expect(steps[0].failed).toBe(true);
  });
});

/**
 * The order the cycle reads in.
 *
 * A hosted run goes implement → verify → review and then round again, and the
 * timeline used to group on the bare phase name — so pass three's edits were
 * drawn above pass one's review, and every "Reviewed the work" heading was the
 * same heading. Ordering by pass first is what makes the loop legible.
 */
describe('phase ordering', () => {
  const sorted = (phases: string[]) =>
    [...phases].sort((a, b) => phaseRank(a) - phaseRank(b));

  it('keeps a single-pass run reading as it always did', () => {
    expect(sorted(['report', 'implement', 'setup', 'verify'])).toEqual([
      'setup',
      'implement',
      'verify',
      'report',
    ]);
  });

  it('puts a cleanup after the report, and an unknown phase before it', () => {
    expect(sorted(['cleanup', 'report', 'mystery', 'implement'])).toEqual([
      'implement',
      'mystery',
      'report',
      'cleanup',
    ]);
  });

  it('puts a later pass after the review that asked for it', () => {
    expect(
      sorted([
        'review-2',
        'setup',
        'revise-2',
        'implement',
        'review',
        'verify',
        'verify-2',
        'report',
      ]),
    ).toEqual([
      'setup',
      'implement',
      'verify',
      'review',
      'revise-2',
      'verify-2',
      'review-2',
      'report',
    ]);
  });

  it('anchors the handback last however many passes there were', () => {
    expect(sorted(['report', 'revise-9'])).toEqual(['revise-9', 'report']);
  });

  it('keeps a phase it has never heard of rather than dropping it', () => {
    // A newer server can emit one, and losing those lines would lose exactly
    // the progress a reader came for.
    const order = sorted(['report', 'telepathy', 'setup']);

    expect(order).toContain('telepathy');
    expect(order[0]).toBe('setup');
  });

  it('numbers the heading rather than repeating it', () => {
    expect(phaseLabel('review')).toBe('Reviewed the work');
    expect(phaseLabel('review-3')).toBe('Reviewed the work (pass 3)');
    expect(phaseLabel('revise-2')).toBe('Fixed what the review found (pass 2)');
    expect(phaseLabel('telepathy')).toBe('telepathy');
  });
});

describe('the newer step data', () => {
  it('folds an edit’s diff into the step that started it', () => {
    const steps = toSteps([
      event('1', 'edit: a/sync.ts', {
        kind: 'write',
        ref: 'e',
        target: 'a/sync.ts',
      }),
      event('2', 'edit finished', {
        kind: 'write',
        ref: 'e',
        ok: true,
        added: 2,
        removed: 1,
        diff: ' keep\n-old\n+new\n+newer',
      }),
    ]);

    expect(steps).toHaveLength(1);
    expect(phrase(steps[0])).toBe('Edited sync.ts');
    expect(steps[0]).toMatchObject({ added: 2, removed: 1, ended: true });
    expect(diffLines(steps[0].diff ?? '')).toEqual([
      { mark: ' ', text: 'keep' },
      { mark: '-', text: 'old' },
      { mark: '+', text: 'new' },
      { mark: '+', text: 'newer' },
    ]);
  });

  it('keeps each thing the agent said as its own row', () => {
    const steps = toSteps([
      event('1', 'First.', { kind: 'note', text: 'First.\nIn full.' }),
      event('2', 'Second.', { kind: 'note', text: 'Second.' }),
    ]);

    expect(steps.map((step) => step.text)).toEqual([
      'First.\nIn full.',
      'Second.',
    ]);
  });

  it('adds up the files a run changed, per path', () => {
    const changes = changesOf(
      toSteps([
        event('1', 'write: a.ts', { kind: 'write', target: 'a.ts', added: 10 }),
        event('2', 'edit: a.ts', { kind: 'write', ref: 'x', target: 'a.ts' }),
        event('3', 'edit finished', {
          kind: 'write',
          ref: 'x',
          ok: true,
          added: 2,
          removed: 3,
          diff: '-a',
        }),
        // An older run: a write with no counts still names its file.
        event('4', 'edit: b.ts', { kind: 'write', target: 'b.ts' }),
      ]),
    );

    expect(changes).toEqual([
      { path: 'a.ts', added: 12, removed: 3 },
      { path: 'b.ts' },
    ]);
  });

  it('collapses setting up into one row', () => {
    const feed = toFeed([
      { ...event('1', 'Fetching the repository'), phase: 'setup' },
      { ...event('2', 'Starting the sandbox'), phase: 'setup' },
      event('3', 'read: a.ts', { kind: 'read', target: 'a.ts' }),
    ]);

    expect(feed).toHaveLength(2);
    expect(feed[0]).toMatchObject({
      type: 'setup',
      lines: ['Fetching the repository', 'Starting the sandbox'],
    });
  });
});

describe('stagesOf', () => {
  const at = (s: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const on = (phase: string, s: number) => ({
    id: `${phase}${s}`,
    phase,
    at: at(s),
    message: '',
  });

  it('marks the stage in flight on a live run and times it from its first event', () => {
    const stages = stagesOf(
      { status: 'RUNNING', phaseTimings: { setup: 38000 } },
      [on('setup', 0), on('implement', 40)],
      Date.parse(at(100)),
    );

    expect(stages.map((stage) => stage.state)).toEqual([
      'done',
      'now',
      'todo',
      'todo',
      'todo',
    ]);
    expect(stages[0].ms).toBe(38000);
    expect(stages[1].ms).toBe(60000);
  });

  it('counts a revision as more work, not as a stage of its own', () => {
    const stages = stagesOf(
      {
        status: 'SUCCEEDED',
        phaseTimings: { implement: 1000, 'revise-2': 500, review: 200 },
      },
      [
        on('setup', 0),
        on('implement', 1),
        on('verify', 2),
        on('review', 3),
        on('revise-2', 4),
        on('report', 5),
      ],
    );

    expect(stages.every((stage) => stage.state === 'done')).toBe(true);
    expect(stages[1].ms).toBe(1500);
  });

  it('shows a local run as set up, work and hand back only', () => {
    const live = stagesOf(
      { status: 'RUNNING', executor: 'local' },
      [on('setup', 0), on('implement', 1)],
      Date.parse(at(10)),
    );

    expect(live.map((stage) => [stage.label, stage.state])).toEqual([
      ['Set up', 'done'],
      ['Work', 'now'],
      ['Hand back', 'todo'],
    ]);

    const finished = stagesOf({ status: 'SUCCEEDED', executor: 'local' }, [
      on('setup', 0),
      on('implement', 1),
      on('report', 2),
    ]);

    expect(finished.every((stage) => stage.state === 'done')).toBe(true);
  });

  it('shows a skipped review on a finished run as skipped', () => {
    const stages = stagesOf({ status: 'SUCCEEDED' }, [
      on('setup', 0),
      on('implement', 1),
      on('verify', 2),
      on('report', 3),
    ]);

    expect(stages[3].state).toBe('skipped');
  });

  it('marks where a failed run stopped', () => {
    const stages = stagesOf({ status: 'FAILED' }, [
      on('setup', 0),
      on('implement', 1),
      on('verify', 2),
    ]);

    expect(stages.map((stage) => stage.state)).toEqual([
      'done',
      'done',
      'fail',
      'todo',
      'todo',
    ]);
  });
});

describe('spend', () => {
  it('reads a run’s spend only when it reported one', () => {
    expect(costOf({ result: { costUsd: 0.25 } })).toBe(0.25);
    expect(costOf({ result: {} })).toBeNull();
    expect(costOf({ result: null })).toBeNull();
  });

  it('never calls a fraction of a cent free', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(1.456)).toBe('$1.46');
  });
});

describe('pullNumber', () => {
  it('reads the number from every host the server opens pull requests on', () => {
    expect(pullNumber('https://github.com/o/r/pull/7')).toBe('7');
    expect(pullNumber('https://forgejo.example/o/r/pulls/12')).toBe('12');
    expect(pullNumber('https://gitlab.com/g/r/-/merge_requests/3')).toBe('3');
    expect(pullNumber(undefined)).toBeNull();
  });
});

describe('questions to a person', () => {
  const at = (s: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const ask = (phase: string | undefined) => ({
    id: 'q1',
    phase,
    at: at(50),
    level: 'INFO',
    message: 'Asked a person: Which one?',
    data: { kind: 'question', agentQuestionId: 'aq1', status: 'OPEN' },
  });

  it('carries the question record on its step', () => {
    const [step] = toSteps([ask('implement')]);

    expect(step.kind).toBe('question');
    expect(step.agentQuestionId).toBe('aq1');
    expect(phrase(step)).toBe('Asked a person: Which one?');
  });

  it('keeps the question in the stage the run is in', () => {
    const before = [
      { id: 's', phase: 'setup', at: at(0), message: '' },
      { id: 'w', phase: 'implement', at: at(10), message: '' },
    ];
    const states = (events: unknown[]) =>
      stagesOf(
        { status: 'RUNNING' },
        events as never[],
        Date.parse(at(60)),
      ).map((stage) => stage.state);
    const expected = ['done', 'now', 'todo', 'todo', 'todo'];

    expect(states([...before, ask('implement')])).toEqual(expected);
    // A question that names no phase must not move the run to another one.
    expect(states([...before, ask(undefined)])).toEqual(expected);
  });

  it('shows under every filter, because it blocks the run', () => {
    const [item] = toFeed([ask('implement')]);

    for (const filter of FILTERS) {
      expect(matches(item, filter)).toBe(true);
    }
  });
});
