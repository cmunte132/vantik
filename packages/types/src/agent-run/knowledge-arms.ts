/**
 * Whether a run was handed the workspace's knowledge. A share of runs is held
 * out, so the two arms can be compared on what happened to their work.
 */
export enum KnowledgeArmEnum {
  TREATMENT = 'TREATMENT',
  HOLDOUT = 'HOLDOUT',
}

export enum AgentRunPullRequestOutcomeEnum {
  MERGED = 'MERGED',
  /** Closed without merging. */
  CLOSED = 'CLOSED',
}

/** A rate, with what it was measured over so a reader can judge it. */
export interface KnowledgeArmRate {
  count: number;
  of: number;
  /** Null when there was nothing to measure. */
  rate: number | null;
}

/** A mean, with how many runs reported the number. */
export interface KnowledgeArmMean {
  mean: number | null;
  runs: number;
}

/** One arm's finished runs, summarised. */
export interface KnowledgeArmStats {
  arm: KnowledgeArmEnum;
  /** Finished runs. The sample size: small arms mean noisy numbers. */
  runs: number;
  /** Runs whose last pass's checks passed, of those whose checks ran. */
  verification: KnowledgeArmRate;
  /** Passes of the implement, check and review cycle, per run. */
  reviewPasses: KnowledgeArmMean;
  costUsd: KnowledgeArmMean;
  /** Pull requests merged, of those merged or closed. */
  merged: KnowledgeArmRate;
  /** Pull requests still open, so not in the merge rate either way. */
  openPullRequests: number;
}

export interface KnowledgeArmComparison {
  /** The share of new runs held out, as configured now. */
  holdoutRate: number;
  /** The earliest run counted, or null for every run. */
  since: string | null;
  arms: KnowledgeArmStats[];
}
