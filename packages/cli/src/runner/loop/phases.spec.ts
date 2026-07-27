/**
 * The loop's rules.
 *
 * Every one of these encodes a finding from the research rather than an
 * implementation detail, which is why they are worth testing directly: the
 * failure modes they prevent are silent. A loop that oscillates still
 * "works". A loop optimising the visible tests still reports a rising score.
 */
import {
  DEFAULT_PHASE_FLAGS,
  decideNext,
  freeze,
  hashOf,
  isTestSpecifiable,
  keepEvidenced,
  passRate,
  resolvePhases,
  tamperedTests,
  type IterationOutcome,
} from './phases';

function outcome(over: Partial<IterationOutcome> = {}): IterationOutcome {
  return {
    index: 1,
    validationPassRate: 0.5,
    heldOutPassRate: 0.5,
    delta: 0,
    verificationPassed: false,
    findingCount: 0,
    diffHash: 'aaaa',
    ...over,
  };
}

describe('phase flags', () => {
  it('ships every phase off', () => {
    // The null hypothesis is that implement plus deterministic verification is
    // as good. Nothing here has beaten that baseline, so nothing is on.
    expect(DEFAULT_PHASE_FLAGS).toEqual({
      specify: false,
      score: false,
      review: false,
    });
  });

  it('leaves unmentioned phases off rather than inheriting them', () => {
    expect(resolvePhases({ specify: true })).toEqual({
      specify: true,
      score: false,
      review: false,
    });
  });

  it('survives a workspace with no configuration', () => {
    expect(resolvePhases(undefined)).toEqual(DEFAULT_PHASE_FLAGS);
  });
});

describe('frozen tests', () => {
  it('detects an implementation that weakened an assertion', () => {
    const frozen = [
      freeze('a.test.ts', 'expect(add(2,2)).toBe(4)', 'validation'),
      freeze('b.test.ts', 'expect(sub(2,2)).toBe(0)', 'heldOut'),
    ];

    const current = new Map([
      // Weakened: the characteristic hack, and structurally detectable.
      ['a.test.ts', 'expect(add(2,2)).toBeDefined()'],
      ['b.test.ts', 'expect(sub(2,2)).toBe(0)'],
    ]);

    expect(tamperedTests(frozen, current).map((test) => test.path)).toEqual([
      'a.test.ts',
    ]);
  });

  it('says nothing when the tests are untouched', () => {
    const frozen = [freeze('a.test.ts', 'expect(1).toBe(1)', 'validation')];
    const current = new Map([['a.test.ts', 'expect(1).toBe(1)']]);

    expect(tamperedTests(frozen, current)).toEqual([]);
  });

  it('hashes contents, not paths', () => {
    expect(hashOf('same')).toBe(hashOf('same'));
    expect(hashOf('same')).not.toBe(hashOf('different'));
  });
});

describe('stop rules', () => {
  it('stops when verification is green and nothing was found', () => {
    expect(
      decideNext({
        history: [outcome({ verificationPassed: true, findingCount: 0 })],
        maxIterations: 5,
      }),
    ).toEqual({ action: 'stop', reason: expect.stringContaining('passed') });
  });

  it('keeps going while verification is red', () => {
    expect(
      decideNext({ history: [outcome()], maxIterations: 5 }),
    ).toEqual({ action: 'continue' });
  });

  it('stops when two passes changed neither the diff nor the verdict', () => {
    // Without this, a critic-driven loop spends its whole budget rewording
    // the same function.
    const decision = decideNext({
      history: [
        outcome({ index: 1, diffHash: 'same', verificationPassed: false }),
        outcome({ index: 2, diffHash: 'same', verificationPassed: false }),
      ],
      maxIterations: 5,
    });

    expect(decision).toEqual({
      action: 'stop',
      reason: expect.stringContaining('neither the diff nor'),
    });
  });

  it('stops at the iteration cap', () => {
    expect(
      decideNext({
        history: [
          outcome({ index: 1, diffHash: 'a' }),
          outcome({ index: 2, diffHash: 'b' }),
        ],
        maxIterations: 2,
      }),
    ).toEqual({ action: 'stop', reason: expect.stringContaining('cap') });
  });
});

describe('the reward-hacking abort', () => {
  it('aborts to human review when Δ widens while the visible score climbs', () => {
    const decision = decideNext({
      history: [
        outcome({
          index: 1,
          validationPassRate: 0.5,
          heldOutPassRate: 0.45,
          delta: 0.05,
          diffHash: 'a',
        }),
        outcome({
          index: 2,
          // Visible score up, held-out score down: it is learning the tests.
          validationPassRate: 0.9,
          heldOutPassRate: 0.5,
          delta: 0.4,
          diffHash: 'b',
        }),
      ],
      maxIterations: 5,
    });

    expect(decision).toMatchObject({
      action: 'abort',
      needsReview: true,
    });
    expect(decision).toHaveProperty(
      'reason',
      expect.stringContaining('optimising the tests'),
    );
  });

  it('does not abort when both suites improve together', () => {
    // A genuinely improving implementation closes the gap or holds it.
    expect(
      decideNext({
        history: [
          outcome({
            index: 1,
            validationPassRate: 0.4,
            heldOutPassRate: 0.3,
            delta: 0.1,
            diffHash: 'a',
          }),
          outcome({
            index: 2,
            validationPassRate: 0.9,
            heldOutPassRate: 0.85,
            delta: 0.05,
            diffHash: 'b',
          }),
        ],
        maxIterations: 5,
      }),
    ).toEqual({ action: 'continue' });
  });

  it('does not abort on a wide but stable gap', () => {
    // One wide gap can just be a hard issue. It is the *widening* that is the
    // signal.
    expect(
      decideNext({
        history: [
          outcome({ index: 1, validationPassRate: 0.9, heldOutPassRate: 0.5, delta: 0.4, diffHash: 'a' }),
          outcome({ index: 2, validationPassRate: 0.9, heldOutPassRate: 0.5, delta: 0.4, diffHash: 'b' }),
        ],
        maxIterations: 5,
      }),
    ).toEqual({ action: 'continue' });
  });
});

describe('review findings', () => {
  it('discards a finding that cites no evidence', () => {
    // Taste from a model that has read the diff is exactly the intrinsic
    // self-correction the evidence says is flat-to-harmful.
    expect(
      keepEvidenced([
        { message: 'This could be cleaner' },
        { message: 'Null deref', evidence: 'src/thing.ts:42' },
      ]),
    ).toEqual([{ message: 'Null deref', evidence: 'src/thing.ts:42' }]);
  });

  it('accepts a failing command as evidence', () => {
    expect(
      keepEvidenced([{ message: 'Tests fail', evidence: '`pnpm test`' }]),
    ).toHaveLength(1);
  });

  it('rejects a vague gesture at a file', () => {
    expect(
      keepEvidenced([{ message: 'Something in the parser', evidence: 'the parser' }]),
    ).toEqual([]);
  });
});

describe('test-specifiability', () => {
  it('accepts an issue with stated criteria', () => {
    expect(
      isTestSpecifiable({
        issue: { title: 'Search returns deleted issues', labels: ['bug'] },
        definitionOfDone: [{ body: 'Deleted issues never appear' }],
      }),
    ).toBe(true);
  });

  it('refuses a refactor, whose DoD is "behaviour unchanged"', () => {
    expect(
      isTestSpecifiable({
        issue: { title: 'Refactor the issue service', labels: [] },
        definitionOfDone: [{ body: 'Behaviour unchanged' }],
      }),
    ).toBe(false);
  });

  it('refuses anything labelled docs or dependencies', () => {
    for (const label of ['docs', 'dependencies', 'chore', 'infra']) {
      expect(
        isTestSpecifiable({
          issue: { title: 'A change', labels: [label] },
          definitionOfDone: [{ body: 'Done' }],
        }),
      ).toBe(false);
    }
  });

  it('refuses an issue with no criteria at all', () => {
    // Nothing to derive a test from. Better to say so than to invent a
    // standard and then grade against it.
    expect(
      isTestSpecifiable({ issue: { title: 'Fix the thing' }, definitionOfDone: [] }),
    ).toBe(false);
  });
});

describe('pass rate', () => {
  it('is zero for an empty suite rather than NaN', () => {
    // A suite that generated nothing must not read as a perfect score.
    expect(passRate({ passed: 0, total: 0 })).toBe(0);
  });

  it('is the fraction that passed', () => {
    expect(passRate({ passed: 3, total: 4 })).toBe(0.75);
  });
});
