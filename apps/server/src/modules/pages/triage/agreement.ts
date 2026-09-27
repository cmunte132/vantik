/**
 * How far triage and people agree, measured the way phase 5 backs off on.
 *
 * Pure: the rows come in, the numbers go out. Kept apart from the services so
 * the arithmetic can be checked against values worked out by hand.
 */
import { createHash } from 'node:crypto';

import {
  KnowledgeEscalationReason,
  KnowledgeTriageDecisionType,
  KnowledgeTriagePolicy,
  KnowledgeVerdict,
} from '@prisma/client';

/** Cohen's kappa for two raters over the same items, with what it rests on. */
export interface Kappa {
  /**
   * From -1 to 1: 1 is complete agreement, 0 is what chance would give, below
   * 0 is worse than chance. Null when there is nothing to measure: no items,
   * or both raters gave every item the same one label, where agreement
   * expected by chance is already complete and kappa is undefined.
   */
  kappa: number | null;
  /** How many items were rated. */
  samples: number;
  /** The share of items the two raters labelled alike. */
  observed: number | null;
  /** The share they would label alike by chance, from how often each used each label. */
  expected: number | null;
}

/**
 * Cohen's kappa over pairs of labels, one pair per item: (p_o - p_e) /
 * (1 - p_e), where p_o is the share of items labelled alike and p_e the sum,
 * over labels, of the product of each rater's share for that label.
 *
 * An item may stand for more than one: with weights, each counts as many
 * items as its weight, which is how a sampled item stands for those it was
 * drawn from. Computed from counts, so hand-worked values come out exactly.
 */
export function cohensKappa<L>(
  pairs: ReadonlyArray<readonly [L, L]>,
  weights?: readonly number[],
): Kappa {
  if (pairs.length === 0) {
    return { kappa: null, samples: 0, observed: null, expected: null };
  }

  const first = new Map<L, number>();
  const second = new Map<L, number>();
  let n = 0;
  let alike = 0;

  pairs.forEach(([a, b], index) => {
    const weight = weights?.[index] ?? 1;

    n += weight;
    first.set(a, (first.get(a) ?? 0) + weight);
    second.set(b, (second.get(b) ?? 0) + weight);

    if (a === b) {
      alike += weight;
    }
  });

  // Σ over labels of count_a × count_b, which is p_e × n².
  let chance = 0;

  for (const [label, count] of first) {
    chance += count * (second.get(label) ?? 0);
  }

  const denominator = n * n - chance;

  return {
    // Zero exactly when both raters used one label throughout; the margin
    // only keeps rounding in the weights from dividing by what is left of it.
    kappa:
      denominator <= n * n * 1e-12 ? null : (alike * n - chance) / denominator,
    samples: pairs.length,
    observed: alike / n,
    expected: chance / (n * n),
  };
}

/** The decision types triage acts on without a person, each measured apart. */
export const ACTING_DECISIONS = [
  KnowledgeTriageDecisionType.AUTO_ACCEPT,
  KnowledgeTriageDecisionType.CORROBORATE,
  KnowledgeTriageDecisionType.REJECT,
] as const;

export type ActingDecision = (typeof ACTING_DECISIONS)[number];

export function isActing(
  decision: KnowledgeTriageDecisionType,
): decision is ActingDecision {
  return (ACTING_DECISIONS as readonly string[]).includes(decision);
}

/**
 * Every decision type agreement is reported for: the acting ones, which can
 * back off, and escalation, which cannot (it already waits on a person) but
 * says whether what triage sent to people needed them.
 */
export const MEASURED_DECISIONS = [
  ...ACTING_DECISIONS,
  KnowledgeTriageDecisionType.ESCALATE,
] as const;

/**
 * Escalation reasons that are triage's judgment of the entry: the two
 * acceptance judgments did not both accept it, or two judgments of how it
 * relates to a neighbour differed. Every other reason is a rule that sends an
 * entry to a person whatever a person then makes of it (it cites nothing, it
 * contradicts a verified entry, it came from outside, a check could not run),
 * so a person accepting it does not say triage should have: triage never may.
 */
export const JUDGMENT_REASONS: ReadonlySet<KnowledgeEscalationReason> = new Set(
  [KnowledgeEscalationReason.JUDGES_DISAGREE],
);

/** A decision as agreement reads it. */
export interface RatedDecision {
  decision: KnowledgeTriageDecisionType;
  reasons: KnowledgeEscalationReason[];
  policy: KnowledgeTriagePolicy | null;
  /** The decision it reached, when its type was backed off. */
  backedOffFrom: KnowledgeTriageDecisionType | null;
}

/**
 * What triage judged, or null when it judged nothing a person could agree
 * with. A decision held back by a back-off is rated as what it reached, so a
 * type that backed off can be seen to recover. A credential is refused
 * whatever agreement says, so that refusal is not rated either.
 */
export function triageLabel(
  row: RatedDecision,
): KnowledgeTriageDecisionType | null {
  if (row.policy === KnowledgeTriagePolicy.SECRET) {
    return null;
  }

  if (row.backedOffFrom) {
    return row.backedOffFrom;
  }

  if (row.decision !== KnowledgeTriageDecisionType.ESCALATE) {
    return row.decision;
  }

  return row.reasons.length > 0 &&
    row.reasons.every((reason) => JUDGMENT_REASONS.has(reason))
    ? KnowledgeTriageDecisionType.ESCALATE
    : null;
}

/**
 * The decision a person's verdict says triage should have made, given the
 * one it did make.
 *
 * Keeping the entry as written is what AUTO_ACCEPT does. Taking it out of use
 * agrees with folding it into what it repeats, or refusing it on a policy,
 * when that is what triage did; otherwise it says the entry needed a person,
 * since triage has no way to drop an entry for being wrong. So does editing
 * it: as written it was neither to keep nor to drop.
 */
export function personDecision(
  verdict: KnowledgeVerdict,
  label: KnowledgeTriageDecisionType,
): KnowledgeTriageDecisionType {
  if (verdict === KnowledgeVerdict.ACCEPTED) {
    return KnowledgeTriageDecisionType.AUTO_ACCEPT;
  }

  if (
    verdict === KnowledgeVerdict.REJECTED &&
    (label === KnowledgeTriageDecisionType.CORROBORATE ||
      label === KnowledgeTriageDecisionType.REJECT)
  ) {
    return label;
  }

  return KnowledgeTriageDecisionType.ESCALATE;
}

/**
 * Whether a person's verdict agrees with what triage decided, or null when
 * triage judged nothing a person could agree with.
 */
export function agrees(
  row: RatedDecision,
  verdict: KnowledgeVerdict,
): boolean | null {
  const label = triageLabel(row);

  return label === null ? null : personDecision(verdict, label) === label;
}

/** How many decisions an audited one stands for: those it was drawn from. */
export function weightOf(row: {
  audit: boolean;
  auditRate: number | null;
}): number {
  return row.audit && row.auditRate ? 1 / row.auditRate : 1;
}

/** Cells of the table one decision type is measured on. */
export interface AgreementCells {
  /** Triage decided it and the person's verdict says so too. */
  both: number;
  /** Triage decided it; the verdict says otherwise. */
  triageOnly: number;
  /** The verdict says it; triage decided otherwise. */
  personOnly: number;
  /** Neither. */
  neither: number;
}

/** Agreement on one decision type. */
export interface TypeAgreement extends Kappa {
  decision: KnowledgeTriageDecisionType;
  /**
   * The verdicts about this type: those where triage decided it, or the
   * verdict says it should have. Verdicts on which neither said it still
   * enter kappa, as the other class, but are no evidence about the type, so
   * the minimum is counted over these alone. Otherwise a type triage has not
   * decided in the window would pass the minimum on verdicts about the
   * others, with nothing to say about itself.
   */
  samples: number;
  /** Verdicts in each cell. */
  counts: AgreementCells;
  /**
   * The same, with each audited decision standing for those it was drawn
   * from, which is what kappa is computed over. Audits are a sample of what
   * triage acted on, while every escalation reaches a person, so counted
   * once each they would make acting look rarer, and chance agreement
   * different, than it is.
   */
  weighted: AgreementCells;
}

/**
 * Kappa for each measured decision type, that type against the rest, over
 * the decisions people gave verdicts on: for type T, triage's decision and
 * the one the verdict says it should have made are each rated "T" or "not
 * T". Decisions triage judged nothing on are left out.
 */
export function agreementByType(
  rows: ReadonlyArray<
    RatedDecision & { verdict: KnowledgeVerdict; weight: number }
  >,
): TypeAgreement[] {
  const rated = rows.flatMap((row) => {
    const label = triageLabel(row);

    return label === null
      ? []
      : [
          {
            label,
            person: personDecision(row.verdict, label),
            weight: row.weight,
          },
        ];
  });

  return MEASURED_DECISIONS.map((decision) => {
    const pairs = rated.map(
      ({ label, person }) => [label === decision, person === decision] as const,
    );
    const weights = rated.map(({ weight }) => weight);
    const cells = (weigh: (index: number) => number): AgreementCells => {
      const sum = (triage: boolean, person: boolean) =>
        pairs.reduce(
          (total, [t, p], index) =>
            t === triage && p === person ? total + weigh(index) : total,
          0,
        );

      return {
        both: sum(true, true),
        triageOnly: sum(true, false),
        personOnly: sum(false, true),
        neither: sum(false, false),
      };
    };

    const counts = cells(() => 1);

    return {
      decision,
      ...cohensKappa(pairs, weights),
      samples: counts.both + counts.triageOnly + counts.personOnly,
      counts,
      weighted: cells((index) => weights[index]),
    };
  });
}

/**
 * Whether a decision type should stop acting. It backs off once it has
 * enough verdicts about it and its kappa is under the floor; once backed off
 * it stays so until it has enough and a kappa at the floor or above, so a
 * type that went wrong resumes on evidence, not on its verdicts ageing out of
 * the window. With no verdicts about it there is no evidence at all, whatever
 * the minimum is set to. With some, kappa is undefined only when every one
 * has both sides saying it, which is complete agreement.
 */
export function shouldBackOff(
  agreement: Pick<TypeAgreement, 'kappa' | 'samples'>,
  settings: { kappaFloor: number; kappaMinSamples: number },
  backedOff: boolean,
): boolean {
  if (agreement.samples === 0 || agreement.samples < settings.kappaMinSamples) {
    return backedOff;
  }

  return (agreement.kappa ?? 1) < settings.kappaFloor;
}

/**
 * Where a decision falls in [0, 1) for the audit draw: fixed by its id, so
 * whether a decision is audited can be worked out again from the id alone.
 */
export function auditDraw(decisionId: string): number {
  // 52 bits, which a double holds exactly.
  const bits = createHash('sha256')
    .update(decisionId)
    .digest('hex')
    .slice(0, 13);

  return Number.parseInt(bits, 16) / 2 ** 52;
}
