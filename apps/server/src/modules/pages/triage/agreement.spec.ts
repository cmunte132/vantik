/**
 * The arithmetic phase 5 backs off on, checked against values worked out by
 * hand. Each expected kappa below is written with the counts it comes from:
 * kappa = (alike × n - chance) / (n² - chance), where chance is the sum over
 * labels of the two raters' counts for that label multiplied.
 */
import { createHash } from 'node:crypto';

import {
  KnowledgeEscalationReason as Reason,
  KnowledgeTriageDecisionType as Decision,
  KnowledgeTriagePolicy as Policy,
  KnowledgeVerdict as Verdict,
} from '@prisma/client';

import {
  agreementByType,
  agrees,
  auditDraw,
  cohensKappa,
  personDecision,
  type RatedDecision,
  shouldBackOff,
  triageLabel,
  weightOf,
} from './agreement';

/** `count` copies of one pair. */
function times<L>(
  count: number,
  pair: readonly [L, L],
): Array<readonly [L, L]> {
  return Array.from({ length: count }, () => pair);
}

type Rated = RatedDecision & { verdict: Verdict; weight: number };

function rated(
  decision: Decision,
  verdict: Verdict,
  overrides: Partial<Rated> = {},
): Rated {
  return {
    decision,
    reasons: [] as Reason[],
    policy: null,
    backedOffFrom: null,
    verdict,
    weight: 1,
    ...overrides,
  };
}

const judged = { reasons: [Reason.JUDGES_DISAGREE] };

describe("Cohen's kappa", () => {
  it('[KG-5.3] is 1 for perfect agreement', () => {
    // alike 4 of 4; chance = 2×2 + 2×2 = 8 of 16.
    expect(
      cohensKappa([
        ['yes', 'yes'],
        ['no', 'no'],
        ['yes', 'yes'],
        ['no', 'no'],
      ]),
    ).toEqual({ kappa: 1, samples: 4, observed: 1, expected: 0.5 });
  });

  it('[KG-5.3] is 0 at chance-level agreement', () => {
    // alike 2 of 4; chance = 2×2 + 2×2 = 8 of 16, the same share.
    expect(
      cohensKappa([
        ['yes', 'yes'],
        ['yes', 'no'],
        ['no', 'yes'],
        ['no', 'no'],
      ]),
    ).toEqual({ kappa: 0, samples: 4, observed: 0.5, expected: 0.5 });

    // Uneven raters, still independent: one says yes 6 times in 10, the
    // other 5. alike 3 + 2 = 5 of 10; chance = 6×5 + 4×5 = 50 of 100.
    expect(
      cohensKappa([
        ...times(3, ['yes', 'yes'] as const),
        ...times(3, ['yes', 'no'] as const),
        ...times(2, ['no', 'yes'] as const),
        ...times(2, ['no', 'no'] as const),
      ]),
    ).toEqual({ kappa: 0, samples: 10, observed: 0.5, expected: 0.5 });
  });

  it('[KG-5.3] matches a textbook table', () => {
    // 50 items: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no. alike 35;
    // chance = 25×30 + 25×20 = 1250; (35×50 - 1250) / (2500 - 1250) = 0.4.
    expect(
      cohensKappa([
        ...times(20, ['yes', 'yes'] as const),
        ...times(5, ['yes', 'no'] as const),
        ...times(10, ['no', 'yes'] as const),
        ...times(15, ['no', 'no'] as const),
      ]),
    ).toEqual({ kappa: 0.4, samples: 50, observed: 0.7, expected: 0.5 });
  });

  it('[KG-5.3] is negative when the raters disagree more than chance would', () => {
    // alike 0; chance = 1×1 + 1×1 = 2; (0 - 2) / (4 - 2) = -1.
    expect(
      cohensKappa([
        ['yes', 'no'],
        ['no', 'yes'],
      ]),
    ).toEqual({ kappa: -1, samples: 2, observed: 0, expected: 0.5 });
  });

  it('[KG-5.3] is undefined in the degenerate single-class case', () => {
    // Both raters say one same label throughout: chance = 5×5 = n², so
    // agreement by chance is already complete and there is nothing to
    // divide by.
    expect(cohensKappa(times(5, ['yes', 'yes'] as const))).toEqual({
      kappa: null,
      samples: 5,
      observed: 1,
      expected: 1,
    });

    // One rater using one label is not degenerate: whatever the other says
    // is chance. alike 3; chance = 4×3 = 12; (12 - 12) / (16 - 12) = 0.
    expect(
      cohensKappa([...times(3, ['no', 'no'] as const), ['no', 'yes']]),
    ).toEqual({ kappa: 0, samples: 4, observed: 0.75, expected: 0.75 });

    expect(cohensKappa([])).toEqual({
      kappa: null,
      samples: 0,
      observed: null,
      expected: null,
    });
  });

  it('[KG-5.3] counts a weighted item as that many items', () => {
    const pairs = [
      ['yes', 'yes'],
      ['no', 'no'],
      ['no', 'yes'],
    ] as const;

    // Unweighted: alike 2; chance = 1×2 + 2×1 = 4; (6 - 4) / (9 - 4) = 0.4.
    expect(cohensKappa(pairs).kappa).toBe(0.4);

    // The first standing for ten: n 12, alike 11; chance = 10×11 + 2×1 =
    // 112; (132 - 112) / (144 - 112) = 0.625. Still three verdicts.
    expect(cohensKappa(pairs, [10, 1, 1])).toMatchObject({
      kappa: 0.625,
      samples: 3,
    });

    // A weight of two is the same as the item twice.
    const doubled = cohensKappa(pairs, [2, 1, 1]);
    const repeated = cohensKappa([pairs[0], ...pairs]);
    expect([doubled.kappa, doubled.observed, doubled.expected]).toEqual([
      repeated.kappa,
      repeated.observed,
      repeated.expected,
    ]);
  });
});

describe('what triage and the person each said', () => {
  it('[KG-5.3] rates what triage judged, and leaves out what a rule decided', () => {
    expect(triageLabel(rated(Decision.AUTO_ACCEPT, Verdict.ACCEPTED))).toBe(
      Decision.AUTO_ACCEPT,
    );
    expect(
      triageLabel(
        rated(Decision.REJECT, Verdict.REJECTED, { policy: Policy.ONE_FACT }),
      ),
    ).toBe(Decision.REJECT);
    // The judgments did not both accept it: triage's own call.
    expect(
      triageLabel(rated(Decision.ESCALATE, Verdict.ACCEPTED, judged)),
    ).toBe(Decision.ESCALATE);

    // Rules that send an entry to a person whatever a person makes of it.
    for (const reason of [
      Reason.UNGROUNDED,
      Reason.CITATION_FAILED,
      Reason.CONTRADICTS_VERIFIED,
      Reason.CONTRADICTS_LOCKED,
      Reason.PIN_REQUEST,
      Reason.BROAD_SCOPE,
      Reason.SUPERSEDE_REQUEST,
      Reason.NO_LLM,
      Reason.EXTERNAL_INPUT,
      Reason.UNKNOWN_SOURCE,
    ]) {
      expect(
        triageLabel(
          rated(Decision.ESCALATE, Verdict.ACCEPTED, { reasons: [reason] }),
        ),
      ).toBeNull();
      // Nor when a judgment is among them.
      expect(
        triageLabel(
          rated(Decision.ESCALATE, Verdict.ACCEPTED, {
            reasons: [Reason.JUDGES_DISAGREE, reason],
          }),
        ),
      ).toBeNull();
    }

    // A credential is refused whatever agreement says.
    expect(
      triageLabel(
        rated(Decision.REJECT, Verdict.ACCEPTED, { policy: Policy.SECRET }),
      ),
    ).toBeNull();

    // Held back by a back-off: rated as what it reached, so recovery shows.
    expect(
      triageLabel(
        rated(Decision.ESCALATE, Verdict.ACCEPTED, {
          reasons: [Reason.LOW_AGREEMENT],
          backedOffFrom: Decision.AUTO_ACCEPT,
        }),
      ),
    ).toBe(Decision.AUTO_ACCEPT);
  });

  it('[KG-5.3] reads a verdict as the decision triage should have made', () => {
    for (const label of [
      Decision.AUTO_ACCEPT,
      Decision.CORROBORATE,
      Decision.REJECT,
      Decision.ESCALATE,
    ]) {
      // Kept as written: accepting was right.
      expect(personDecision(Verdict.ACCEPTED, label)).toBe(
        Decision.AUTO_ACCEPT,
      );
      // Edited: as written it needed a person.
      expect(personDecision(Verdict.EDITED, label)).toBe(Decision.ESCALATE);
    }

    // Taken out of use: right to fold in or refuse, when that is what
    // triage did; otherwise it needed a person, since triage cannot drop an
    // entry for being wrong.
    expect(personDecision(Verdict.REJECTED, Decision.CORROBORATE)).toBe(
      Decision.CORROBORATE,
    );
    expect(personDecision(Verdict.REJECTED, Decision.REJECT)).toBe(
      Decision.REJECT,
    );
    expect(personDecision(Verdict.REJECTED, Decision.AUTO_ACCEPT)).toBe(
      Decision.ESCALATE,
    );
    expect(personDecision(Verdict.REJECTED, Decision.ESCALATE)).toBe(
      Decision.ESCALATE,
    );

    expect(
      agrees(rated(Decision.AUTO_ACCEPT, Verdict.ACCEPTED), Verdict.ACCEPTED),
    ).toBe(true);
    expect(
      agrees(rated(Decision.AUTO_ACCEPT, Verdict.REJECTED), Verdict.REJECTED),
    ).toBe(false);
    expect(
      agrees(rated(Decision.CORROBORATE, Verdict.REJECTED), Verdict.REJECTED),
    ).toBe(true);
    expect(
      agrees(rated(Decision.CORROBORATE, Verdict.ACCEPTED), Verdict.ACCEPTED),
    ).toBe(false);
    expect(
      agrees(rated(Decision.ESCALATE, Verdict.EDITED, judged), Verdict.EDITED),
    ).toBe(true);
    expect(
      agrees(
        rated(Decision.ESCALATE, Verdict.ACCEPTED, judged),
        Verdict.ACCEPTED,
      ),
    ).toBe(false);
    expect(
      agrees(
        rated(Decision.ESCALATE, Verdict.ACCEPTED, {
          reasons: [Reason.UNGROUNDED],
        }),
        Verdict.ACCEPTED,
      ),
    ).toBeNull();
  });
});

describe('agreement per decision type', () => {
  it('[KG-5.3] measures each type against the rest, with the counts', () => {
    const [accept, corroborate, reject, escalate] = agreementByType([
      ...Array.from({ length: 3 }, () =>
        rated(Decision.AUTO_ACCEPT, Verdict.ACCEPTED),
      ),
      rated(Decision.AUTO_ACCEPT, Verdict.REJECTED),
      rated(Decision.ESCALATE, Verdict.REJECTED, judged),
      rated(Decision.ESCALATE, Verdict.EDITED, judged),
      rated(Decision.ESCALATE, Verdict.ACCEPTED, judged),
      rated(Decision.CORROBORATE, Verdict.REJECTED),
      rated(Decision.CORROBORATE, Verdict.REJECTED),
      rated(Decision.CORROBORATE, Verdict.ACCEPTED),
      rated(Decision.REJECT, Verdict.REJECTED, { policy: Policy.ONE_FACT }),
      rated(Decision.ESCALATE, Verdict.ACCEPTED, {
        reasons: [Reason.LOW_AGREEMENT],
        backedOffFrom: Decision.AUTO_ACCEPT,
      }),
      // Left out: a rule escalated it, and a credential was refused.
      rated(Decision.ESCALATE, Verdict.ACCEPTED, {
        reasons: [Reason.UNGROUNDED],
      }),
      rated(Decision.REJECT, Verdict.ACCEPTED, { policy: Policy.SECRET }),
    ]);

    // AUTO_ACCEPT: 12 rated, 7 about acceptance. Both 4 (three accepted,
    // one held back and accepted), triage only 1, person only 2 (an
    // escalation and a folded repeat, each accepted), neither 5. alike 9;
    // chance = 5×6 + 7×6 = 72; (108 - 72) / (144 - 72) = 0.5.
    expect(accept).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      kappa: 0.5,
      samples: 7,
      observed: 0.75,
      expected: 0.5,
      counts: { both: 4, triageOnly: 1, personOnly: 2, neither: 5 },
    });

    // CORROBORATE: both 2, triage only 1, neither 9. alike 11; chance =
    // 3×2 + 9×10 = 96; (132 - 96) / (144 - 96) = 0.75.
    expect(corroborate).toMatchObject({
      decision: Decision.CORROBORATE,
      kappa: 0.75,
      samples: 3,
      counts: { both: 2, triageOnly: 1, personOnly: 0, neither: 9 },
    });

    // REJECT: the one refusal was right, and nothing else was refused by
    // anyone. chance = 1×1 + 11×11 = 122; (144 - 122) / (144 - 122) = 1.
    expect(reject).toMatchObject({
      decision: Decision.REJECT,
      kappa: 1,
      samples: 1,
      counts: { both: 1, triageOnly: 0, personOnly: 0, neither: 11 },
    });

    // ESCALATE, reported though it never backs off: both 2 (set aside and
    // edited), triage only 1 (accepted), person only 1 (an acceptance set
    // aside), neither 8. alike 10; chance = 3×3 + 9×9 = 90; (120 - 90) /
    // (144 - 90) = 5/9.
    expect(escalate).toMatchObject({
      decision: Decision.ESCALATE,
      samples: 4,
      counts: { both: 2, triageOnly: 1, personOnly: 1, neither: 8 },
    });
    expect(escalate.kappa).toBeCloseTo(5 / 9, 12);
  });

  it('[KG-5.4] counts as evidence about a type only the verdicts where it was said', () => {
    const [accept, corroborate, reject] = agreementByType(
      Array.from({ length: 25 }, () =>
        rated(Decision.AUTO_ACCEPT, Verdict.ACCEPTED),
      ),
    );

    // Twenty-five verdicts, every one about acceptance and none about
    // folding in or refusing, so those two have nothing to go on.
    expect(accept).toMatchObject({ samples: 25, kappa: null });
    expect(corroborate).toMatchObject({ samples: 0, kappa: null });
    expect(reject).toMatchObject({ samples: 0, kappa: null });
  });

  it('[KG-5.3] lets an audited decision stand for those it was drawn from', () => {
    const audited = weightOf({ audit: true, auditRate: 0.1 });

    expect(audited).toBe(10);
    expect(weightOf({ audit: false, auditRate: 0.1 })).toBe(1);
    expect(weightOf({ audit: false, auditRate: null })).toBe(1);

    const [accept] = agreementByType([
      rated(Decision.AUTO_ACCEPT, Verdict.ACCEPTED, { weight: audited }),
      rated(Decision.ESCALATE, Verdict.REJECTED, judged),
      rated(Decision.ESCALATE, Verdict.REJECTED, judged),
      rated(Decision.ESCALATE, Verdict.ACCEPTED, judged),
    ]);

    // n 13, alike 12; chance = 10×11 + 3×2 = 116; (156 - 116) / (169 -
    // 116) = 40/53. Counted once each it would be (12 - 8) / (16 - 8) = 0.5.
    expect(accept.kappa).toBeCloseTo(40 / 53, 12);
    expect(accept).toMatchObject({
      samples: 2,
      counts: { both: 1, triageOnly: 0, personOnly: 1, neither: 2 },
      weighted: { both: 10, triageOnly: 0, personOnly: 1, neither: 2 },
    });
  });
});

describe('backing off', () => {
  const settings = { kappaFloor: 0.6, kappaMinSamples: 20 };

  it('[KG-5.4] backs off under the floor, once there are enough verdicts', () => {
    expect(shouldBackOff({ kappa: 0.5, samples: 20 }, settings, false)).toBe(
      true,
    );
    expect(shouldBackOff({ kappa: 0.59, samples: 40 }, settings, false)).toBe(
      true,
    );
    // Too few to say.
    expect(shouldBackOff({ kappa: 0.1, samples: 19 }, settings, false)).toBe(
      false,
    );
    // At the floor is not under it.
    expect(shouldBackOff({ kappa: 0.6, samples: 20 }, settings, false)).toBe(
      false,
    );
    // With verdicts about the type, undefined only when both said it on
    // every one.
    expect(shouldBackOff({ kappa: null, samples: 25 }, settings, false)).toBe(
      false,
    );
  });

  it('[KG-5.4] changes nothing on no verdicts about the type, whatever the minimum', () => {
    const none = { kappaFloor: 0.6, kappaMinSamples: 0 };

    expect(shouldBackOff({ kappa: null, samples: 0 }, none, true)).toBe(true);
    expect(shouldBackOff({ kappa: null, samples: 0 }, none, false)).toBe(false);
    expect(shouldBackOff({ kappa: 0.2, samples: 1 }, none, false)).toBe(true);
  });

  it('[KG-5.4] resumes only on enough verdicts at the floor or above', () => {
    expect(shouldBackOff({ kappa: 0.6, samples: 20 }, settings, true)).toBe(
      false,
    );
    expect(shouldBackOff({ kappa: null, samples: 20 }, settings, true)).toBe(
      false,
    );
    expect(shouldBackOff({ kappa: 0.59, samples: 30 }, settings, true)).toBe(
      true,
    );
    // Its verdicts ageing out of the window is not recovery.
    expect(shouldBackOff({ kappa: 0.95, samples: 19 }, settings, true)).toBe(
      true,
    );
    expect(shouldBackOff({ kappa: null, samples: 0 }, settings, true)).toBe(
      true,
    );
  });
});

describe('the audit draw', () => {
  it('[KG-5.2] is fixed by the decision id', () => {
    const id = '3f2c1a9e-4b7d-4e21-9c55-0d8a6b1e2f47';

    // The first 52 bits of the id's SHA-256, as a share of 2^52.
    expect(auditDraw(id)).toBe(
      Number.parseInt(
        createHash('sha256').update(id).digest('hex').slice(0, 13),
        16,
      ) /
        2 ** 52,
    );
    expect(auditDraw(id)).toBeCloseTo(0.8565178459820968, 15);
    expect(auditDraw(id)).toBe(auditDraw(id));
    expect(auditDraw(id)).not.toBe(
      auditDraw('00000000-0000-4000-8000-000000000000'),
    );
  });

  it('[KG-5.2] falls under a rate for that share of decisions', () => {
    const draws = Array.from({ length: 20_000 }, (_, index) => {
      const hex = createHash('md5').update(`decision ${index}`).digest('hex');

      return auditDraw(
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
      );
    });

    expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true);

    for (const rate of [0.1, 0.25, 0.5]) {
      const share = draws.filter((draw) => draw < rate).length / draws.length;

      expect(Math.abs(share - rate)).toBeLessThan(0.01);
    }
  });
});
