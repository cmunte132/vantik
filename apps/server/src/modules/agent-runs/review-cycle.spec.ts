import { AGENT_RUN_DEFAULT_MAX_CYCLES } from '@vantikhq/types';

import {
  DEFAULT_DURATION_MS,
  type CyclePass,
  decideCycle,
  keepEvidenced,
  parseReviewVerdict,
  phaseName,
  resolveCycleLimits,
  reviewVerdictPath,
} from './review-cycle';

/**
 * When the cycle stops, and what it believed when it stopped.
 *
 * These are the decisions that cost money and that nobody can see going wrong
 * from the outside: a loop that will not stop bills the workspace, and a loop
 * that accepts too readily produces a pull request nothing has actually
 * checked. Both fail silently in production and neither needs a sandbox to
 * test, which is why the decisions live away from the executor.
 */

const NOW = 1_000_000;

const limits = (over: Partial<ReturnType<typeof resolveCycleLimits>> = {}) => ({
  maxCycles: 3,
  maxCostUsd: 5,
  deadlineAt: NOW + 60_000,
  ...over,
});

const pass = (over: Partial<CyclePass> = {}): CyclePass => ({
  index: 1,
  verificationPassed: true,
  accepted: false,
  findings: [{ message: 'Broken', evidence: 'src/a.ts:1' }],
  diffHash: 'aaaa',
  ...over,
});

const spend = (costUsd = 0) => ({ costUsd, turns: 10 });

describe('parseReviewVerdict', () => {
  it('reads the verdict a reviewer was asked to write', () => {
    const verdict = parseReviewVerdict(
      JSON.stringify({
        accepted: false,
        summary: 'Two criteria are unmet.',
        findings: [
          {
            message: 'Criterion 2 is not implemented',
            evidence: 'src/parser.ts:88',
            severity: 'high',
            criterion: 2,
          },
        ],
      }),
    );

    expect(verdict).toEqual({
      accepted: false,
      summary: 'Two criteria are unmet.',
      findings: [
        {
          message: 'Criterion 2 is not implemented',
          evidence: 'src/parser.ts:88',
          severity: 'high',
          criterion: 2,
        },
      ],
    });
  });

  it('accepts the JSON a model wrapped in a code fence', () => {
    // A model told to write JSON writes a fenced block roughly a third of the
    // time, and spending a whole review pass to insist otherwise is expensive.
    const verdict = parseReviewVerdict(
      '```json\n{"accepted": true, "findings": []}\n```',
    );

    expect(verdict?.accepted).toBe(true);
  });

  it('finds the object when the model wrote prose around it', () => {
    const verdict = parseReviewVerdict(
      'Here is my verdict:\n{"accepted": true, "findings": []}\nHope that helps.',
    );

    expect(verdict?.accepted).toBe(true);
  });

  it('treats anything but a real boolean true as a rejection', () => {
    // Every non-empty string is truthy, so a reviewer answering `"no"` would be
    // recorded as a yes by anything that tested the field for truthiness.
    expect(parseReviewVerdict('{"accepted": "no"}')?.accepted).toBe(false);
    expect(parseReviewVerdict('{"accepted": "true"}')?.accepted).toBe(false);
    expect(parseReviewVerdict('{"accepted": 1}')?.accepted).toBe(false);
    expect(parseReviewVerdict('{"findings": []}')?.accepted).toBe(false);
  });

  it('returns nothing rather than throwing on what it cannot read', () => {
    // The file is written by a model, so truncation and nonsense are the normal
    // case. A parser that dies on one costs the run a whole pass.
    expect(parseReviewVerdict(null)).toBeNull();
    expect(parseReviewVerdict('')).toBeNull();
    expect(parseReviewVerdict('no idea')).toBeNull();
    expect(parseReviewVerdict('{"accepted": true')).toBeNull();
  });

  it('drops findings that carry no message', () => {
    const verdict = parseReviewVerdict(
      '{"accepted": false, "findings": [{"evidence": "a.ts:1"}, "nope", null]}',
    );

    expect(verdict?.findings).toEqual([]);
  });
});

describe('keepEvidenced', () => {
  it('keeps a finding that points at a file and a line', () => {
    expect(
      keepEvidenced([{ message: 'Wrong', evidence: 'src/thing.ts:42' }]),
    ).toHaveLength(1);
  });

  it('keeps a finding whose evidence is a command that fails', () => {
    expect(
      keepEvidenced([{ message: 'Tests fail', evidence: '`pnpm test`' }]),
    ).toHaveLength(1);
  });

  it('drops a finding that cites nothing', () => {
    // A reviewer that cannot point at anything is offering taste, and taste
    // from a model that has read a diff is exactly the self-correction the
    // whole design treats as worthless.
    expect(
      keepEvidenced([
        {
          message: 'Something in the parser feels off',
          evidence: 'the parser',
        },
        { message: 'No evidence at all' },
      ]),
    ).toEqual([]);
  });

  it('loses the nitpicks rather than the blocker when it has to cut', () => {
    const findings = [
      { message: 'low one', evidence: 'a.ts:1', severity: 'low' as const },
      { message: 'high one', evidence: 'b.ts:2', severity: 'high' as const },
      { message: 'medium one', evidence: 'c.ts:3' },
    ];

    expect(
      keepEvidenced(findings, 2).map((finding) => finding.message),
    ).toEqual(['high one', 'medium one']);
  });
});

describe('decideCycle', () => {
  it('accepts when the reviewer accepted and the checks passed', () => {
    const decision = decideCycle({
      history: [pass({ accepted: true, findings: [] })],
      spend: spend(),
      limits: limits(),
      now: NOW,
    });

    expect(decision.action).toBe('accept');
  });

  it('accepts on the last affordable pass rather than reporting no budget', () => {
    // Acceptance costs nothing, so a run that finished on the pass that spent
    // its last dollar has still finished. Testing the budget first would report
    // completed work as a run that ran out.
    const decision = decideCycle({
      history: [pass({ accepted: true, findings: [] })],
      spend: spend(5),
      limits: limits({ maxCostUsd: 5 }),
      now: NOW,
    });

    expect(decision.action).toBe('accept');
  });

  it('refuses to accept a tree whose checks are failing', () => {
    // The reviewer has contradicted something that was actually executed, and
    // the executed thing wins.
    const decision = decideCycle({
      history: [
        pass({ accepted: true, findings: [], verificationPassed: false }),
      ],
      spend: spend(),
      limits: limits(),
      now: NOW,
    });

    expect(decision.action).not.toBe('accept');
  });

  it('sends evidenced findings back to be fixed', () => {
    const decision = decideCycle({
      history: [pass()],
      spend: spend(),
      limits: limits(),
      now: NOW,
    });

    expect(decision.action).toBe('revise');
  });

  it('stops when the money is spent, and says so', () => {
    const decision = decideCycle({
      history: [pass()],
      spend: spend(5.5),
      limits: limits({ maxCostUsd: 5 }),
      now: NOW,
    });

    expect(decision.action).toBe('handOver');
    expect(decision.reason).toContain('$5.50');
  });

  it('stops when the wall clock is up', () => {
    const decision = decideCycle({
      history: [pass()],
      spend: spend(),
      limits: limits({ deadlineAt: NOW - 1 }),
      now: NOW,
    });

    expect(decision.action).toBe('handOver');
    expect(decision.reason).toContain('wall-clock');
  });

  it('stops at the pass cap', () => {
    const decision = decideCycle({
      history: [pass({ index: 1 }), pass({ index: 2 }), pass({ index: 3 })],
      spend: spend(),
      limits: limits({ maxCycles: 3 }),
      now: NOW,
    });

    expect(decision.action).toBe('handOver');
    expect(decision.reason).toContain('3 review pass');
  });

  it('stops when two passes in a row changed nothing', () => {
    // Without this, a critic-driven loop spends its whole budget rewording the
    // same function while the reviewer keeps filing the same finding.
    const decision = decideCycle({
      history: [
        pass({ index: 1, diffHash: 'same' }),
        pass({ index: 2, diffHash: 'same' }),
      ],
      spend: spend(),
      limits: limits({ maxCycles: 10 }),
      now: NOW,
    });

    expect(decision.action).toBe('handOver');
    expect(decision.reason).toContain('changed neither');
  });

  it('keeps going when the tree did change, even if the checks did not move', () => {
    const decision = decideCycle({
      history: [
        pass({ index: 1, diffHash: 'one' }),
        pass({ index: 2, diffHash: 'two' }),
      ],
      spend: spend(),
      limits: limits({ maxCycles: 10 }),
      now: NOW,
    });

    expect(decision.action).toBe('revise');
  });

  it('does not call two unknown tree hashes the same tree', () => {
    // A guest that cannot produce a hash costs the run its oscillation check,
    // not its budget. Treating two nulls as equal would stop every such run
    // after two passes.
    const decision = decideCycle({
      history: [
        pass({ index: 1, diffHash: null }),
        pass({ index: 2, diffHash: null }),
      ],
      spend: spend(),
      limits: limits({ maxCycles: 10 }),
      now: NOW,
    });

    expect(decision.action).toBe('revise');
  });

  it('hands over when the reviewer gave no readable verdict', () => {
    // "The reviewer did not answer" and "the reviewer said yes" must never
    // collapse into the same outcome.
    const decision = decideCycle({
      history: [pass({ accepted: null, findings: [] })],
      spend: spend(),
      limits: limits(),
      now: NOW,
    });

    expect(decision.action).toBe('handOver');
    expect(decision.reason).toContain('could be read');
  });

  it('says the reviewer was silent rather than that the budget ran out', () => {
    // Both are true when the cap is one pass, and they stop the run either
    // way — but "it hit the pass limit" tells a person the work was reviewed
    // and is nearly there. It was not reviewed at all, which is the fact worth
    // reading.
    const decision = decideCycle({
      history: [pass({ accepted: null, findings: [] })],
      spend: spend(99),
      limits: limits({ maxCycles: 1, maxCostUsd: 5 }),
      now: NOW,
    });

    expect(decision.reason).toContain('could be read');
    expect(decision.reason).not.toContain('limit for this issue');
  });

  it('sends a red suite back even when the reviewer cited nothing', () => {
    // A failing check is specific enough to act on whether or not a reviewer
    // thought to cite it, and the revision prompt carries the command and its
    // output either way. Handing a person a diff with failing tests, while
    // there was budget to fix them, gives up one step early.
    const decision = decideCycle({
      history: [
        pass({ accepted: false, findings: [], verificationPassed: false }),
      ],
      spend: spend(),
      limits: limits(),
      now: NOW,
    });

    expect(decision.action).toBe('revise');
    expect(decision.reason).toContain('checks are failing');
  });

  it('hands over on a rejection nobody can act on', () => {
    // The reviewer said no and could not say where. Sending that back produces
    // a pass of churn and another identical rejection.
    const decision = decideCycle({
      history: [pass({ accepted: false, findings: [] })],
      spend: spend(),
      limits: limits(),
      now: NOW,
    });

    expect(decision.action).toBe('handOver');
    expect(decision.reason).toContain('cited no file');
  });
});

describe('resolveCycleLimits', () => {
  it('falls back to the stated defaults', () => {
    const resolved = resolveCycleLimits(undefined, 1000);

    expect(resolved.maxCycles).toBe(AGENT_RUN_DEFAULT_MAX_CYCLES);
    expect(resolved.maxCostUsd).toBe(5);
    expect(resolved.deadlineAt).toBe(1000 + DEFAULT_DURATION_MS);
  });

  it('takes the run’s own ceilings when it has them', () => {
    const resolved = resolveCycleLimits(
      { maxCycles: 1, maxCostUsd: 20, maxDurationMs: 5000 },
      1000,
    );

    expect(resolved).toEqual({
      maxCycles: 1,
      maxCostUsd: 20,
      deadlineAt: 6000,
    });
  });

  it('ignores a ceiling that is not a usable number', () => {
    // Free-form JSON somebody may have hand-edited. A zero or a negative here
    // would be a run that can never take a pass, reported as a budget failure.
    const resolved = resolveCycleLimits(
      { maxCycles: 0, maxCostUsd: -1, maxDurationMs: Number.NaN },
      1000,
    );

    expect(resolved.maxCycles).toBe(AGENT_RUN_DEFAULT_MAX_CYCLES);
    expect(resolved.maxCostUsd).toBe(5);
    expect(resolved.deadlineAt).toBe(1000 + DEFAULT_DURATION_MS);
  });
});

describe('the names a pass writes under', () => {
  it('leaves the first pass reading as it always did', () => {
    // A run that never needed a second pass should be indistinguishable in the
    // timeline from one taken before this loop existed.
    expect(phaseName('implement', 1)).toBe('implement');
    expect(phaseName('review', 1)).toBe('review');
  });

  it('numbers later passes so the timeline does not merge them', () => {
    expect(phaseName('revise', 2)).toBe('revise-2');
    expect(phaseName('review', 3)).toBe('review-3');
  });

  it('puts the verdict outside the checkout', () => {
    // Written inside it, the reviewer's own answer would land in the diff the
    // human reviews.
    expect(reviewVerdictPath(2)).toBe('/workspace/review-2.json');
    expect(reviewVerdictPath(2).startsWith('/workspace/repo')).toBe(false);
  });
});
