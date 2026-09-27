import type {
  KnowledgeArmComparison,
  KnowledgeArmMean,
  KnowledgeArmRate,
  KnowledgeArmStats,
} from '@vantikhq/types';

/**
 * Below this many finished runs in an arm, the comparison says so before it
 * says anything else. Not a statistical test: a line under which a difference
 * between the arms is far more likely to be chance than anything the
 * knowledge did.
 */
export const FEW_RUNS = 30;

export interface ArmRow {
  label: string;
  runs: string;
  verification: string;
  reviewPasses: string;
  cost: string;
  merged: string;
}

const LABELS: Record<string, string> = {
  TREATMENT: 'Given knowledge',
  HOLDOUT: 'Held out',
};

/** One row per arm, every figure beside what it was measured over. */
export function armRows(comparison: KnowledgeArmComparison): ArmRow[] {
  return comparison.arms.map((arm: KnowledgeArmStats) => ({
    label: LABELS[arm.arm] ?? arm.arm,
    runs: String(arm.runs),
    verification: percentOf(arm.verification),
    reviewPasses: meanOf(arm.reviewPasses, (value) => value.toFixed(1)),
    cost: meanOf(arm.costUsd, (value) => `$${value.toFixed(2)}`),
    merged:
      percentOf(arm.merged) +
      (arm.openPullRequests ? ` · ${arm.openPullRequests} open` : ''),
  }));
}

/**
 * What to say before the numbers: nothing, when both arms have enough runs to
 * be worth comparing, and otherwise how far they are from it.
 */
export function sampleWarning(
  comparison: KnowledgeArmComparison,
): string | null {
  const smallest = Math.min(...comparison.arms.map((arm) => arm.runs));

  if (comparison.arms.length === 0 || smallest === 0) {
    return 'No finished runs in one of the arms yet, so there is nothing to compare.';
  }

  return smallest < FEW_RUNS
    ? `The smaller arm has ${smallest} finished run${smallest === 1 ? '' : 's'}. ` +
        `Until each has about ${FEW_RUNS}, a difference is more likely chance than the knowledge.`
    : null;
}

function percentOf(rate: KnowledgeArmRate): string {
  return rate.rate === null
    ? '—'
    : `${Math.round(rate.rate * 100)}% (${rate.count} of ${rate.of})`;
}

function meanOf(
  mean: KnowledgeArmMean,
  format: (value: number) => string,
): string {
  return mean.mean === null ? '—' : `${format(mean.mean)} (${mean.runs} runs)`;
}
