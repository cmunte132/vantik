import { describe, expect, it } from 'vitest';

import { type Step, phrase, toSteps } from './run-timeline';

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
      event('1', 'read: a/repo-routing.ts', { kind: 'read', target: 'a/repo-routing.ts' }),
      event('2', 'read: a/context-pack.ts', { kind: 'read', target: 'a/context-pack.ts' }),
      event('3', 'read: a/sandbox.ts', { kind: 'read', target: 'a/sandbox.ts' }),
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0].count).toBe(3);
    expect(steps[0].targets).toEqual([
      'a/repo-routing.ts',
      'a/context-pack.ts',
      'a/sandbox.ts',
    ]);
    expect(phrase(steps[0])).toBe('Read repo-routing.ts and 2 more');
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
    expect(phrase(steps[0])).toBe('Ran the tests — failed');
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
    expect(phrase(steps[0])).toBe('Ran the tests — 6 passed');
  });

  it('keeps a failure whose start it never saw, rather than swallowing it', () => {
    // An outcome with no matching ref is all the reader has. Dropping it would
    // lose the only record that something broke.
    const steps = toSteps([
      event('1', 'bash failed', { kind: 'bash', ref: 'gone', ok: false }, 'ERROR'),
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
