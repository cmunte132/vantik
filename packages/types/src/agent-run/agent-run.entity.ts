/**
 * One agent's attempt at one issue.
 *
 * Shared between the server, the webapp and the runner, so the status machine
 * below is the single definition all three agree on. The transition table in
 * particular is exported rather than reimplemented per caller: a runner that
 * decides for itself which states are terminal will eventually disagree with
 * the server about a run it no longer owns.
 */

export const AGENT_RUN_STATUSES = [
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
  'NEEDS_REVIEW',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_RUN_FAILURES = [
  'ENVIRONMENT_SETUP_FAILED',
  'HARNESS_CRASHED',
  'BUDGET_EXHAUSTED',
  'NO_DIFF_PRODUCED',
  'VERIFICATION_FAILED',
  'PUSH_REJECTED',
  'PR_CREATION_FAILED',
  'EGRESS_DENIED',
  'LEASE_LOST',
  'NOT_TEST_SPECIFIABLE',
  'REWARD_HACK_SUSPECTED',
] as const;

export type AgentRunFailure = (typeof AGENT_RUN_FAILURES)[number];

export const AGENT_RUN_EVENT_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

export type AgentRunEventLevel = (typeof AGENT_RUN_EVENT_LEVELS)[number];

/**
 * Every legal move, and by omission every illegal one.
 *
 * Terminal states map to an empty list — terminal is terminal, and a report
 * arriving for a run that already expired is refused rather than quietly
 * resurrecting it. That case is not hypothetical: a runner whose process
 * paused long enough to miss a heartbeat comes back believing it still owns
 * the work.
 */
export const AGENT_RUN_TRANSITIONS: Record<AgentRunStatus, AgentRunStatus[]> = {
  QUEUED: ['CLAIMED', 'CANCELED', 'FAILED'],
  // A backend can fail before it starts — a checkout that will not clone never
  // reaches RUNNING, and that is ENVIRONMENT_SETUP_FAILED, not a crash.
  CLAIMED: ['RUNNING', 'FAILED', 'CANCELED', 'EXPIRED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED', 'NEEDS_REVIEW'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
  EXPIRED: [],
  NEEDS_REVIEW: [],
};

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return AGENT_RUN_TRANSITIONS[status].length === 0;
}

export function canTransitionAgentRun(
  from: AgentRunStatus,
  to: AgentRunStatus,
): boolean {
  return AGENT_RUN_TRANSITIONS[from].includes(to);
}

/**
 * States a run can be retried from.
 *
 * EXPIRED is the automatic one — nothing is known about what the runner was
 * doing, so trying again is the only information-gaining move. FAILED and
 * NEEDS_REVIEW are retryable by a person who has read why. SUCCEEDED and
 * CANCELED are not: re-running work that succeeded produces a second PR for
 * the same issue, and re-running work someone deliberately stopped is the
 * opposite of what they asked for.
 */
export const RETRYABLE_AGENT_RUN_STATUSES: AgentRunStatus[] = [
  'EXPIRED',
  'FAILED',
  'NEEDS_REVIEW',
];

/**
 * How finished work is handed back.
 *
 * A pull request is only available when the workspace has a remote SCM
 * connected. Without one — a local checkout, a self-hosted install with no
 * GitHub integration, an air-gapped repo — there is nowhere to push and no PR
 * to open, and a feature that only works with GitHub attached is a feature
 * most self-hosters cannot use.
 *
 * So `worktree` is a first-class delivery, not a degraded one: the run commits
 * to a branch and leaves it checked out in a `git worktree` beside the repo,
 * and the user reviews it with the diff tooling they already have. Same
 * lifecycle, same summary comment, same counters — only the artifact at the
 * end differs.
 */
export const AGENT_RUN_DELIVERIES = ['pull_request', 'worktree'] as const;

export type AgentRunDelivery = (typeof AGENT_RUN_DELIVERIES)[number];

/** What a finished run reports back. Rendered by the server, never by the executor. */
export interface AgentRunResult {
  /** Which artifact this run produced. */
  delivery?: AgentRunDelivery;
  branch?: string;
  /** Pull request url. Only for `pull_request` delivery. */
  prUrl?: string;
  /** The LinkedIssue row the server created for that PR. */
  linkedIssueId?: string;
  /**
   * Absolute path to the worktree holding the branch. Only for `worktree`
   * delivery, and only meaningful on the machine that ran it — which is the
   * BYO runner's own machine, where the user is sitting.
   */
  worktreePath?: string;
  /** Commit the branch ends at. */
  headCommit?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Provider-reported spend in USD, when the provider reports one. */
  costUsd?: number;
  /** Denied egress attempts. A spike is the clearest injection signal we get. */
  egressDenied?: number;
}

/** Milliseconds spent in each phase. Sparse — only phases that ran appear. */
export interface AgentRunPhaseTimings {
  setup?: number;
  specify?: number;
  implement?: number;
  score?: number;
  review?: number;
  report?: number;
}

/**
 * How to run and verify this repository.
 *
 * Verification commands are the highest-leverage thing in here. Whether the
 * agent can run the repo's own tests and react to the output is the difference
 * between a plausible diff and a working one — worth more than a better model.
 * Setup is kept separate from verification because the hosted executor runs
 * them in different phases, with different credentials and different egress.
 */
export interface AgentRunRepoConfig {
  /** Remote to clone. Absent for a run against a local checkout. */
  repoUrl?: string;
  /**
   * Local repository the runner works in, when there is no remote to clone.
   * The runner's own path; the server only stores it.
   */
  repoPath?: string;
  /**
   * Where to hand the work back. Defaults to `pull_request` when the
   * workspace has an SCM connected and `worktree` when it does not, so a
   * local-only install needs no configuration to get something reviewable.
   */
  delivery?: AgentRunDelivery;
  /**
   * Where worktrees are created for `worktree` delivery. Defaults to a
   * sibling of the repo, so it is next to the work but never inside it —
   * a worktree under the repo would show up in the agent's own file listings
   * and in its diffs.
   */
  worktreeRoot?: string;
  baseBranch?: string;
  /** Where the runner should put the work. Templated with the issue key. */
  branchPrefix?: string;
  /** Run once, with network and install credentials. */
  setupCommands?: string[];
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
}

export interface AgentRunLimits {
  /** Wall-clock cap for the whole run. */
  maxDurationMs?: number;
  maxTokens?: number;
  maxIterations?: number;
  maxCostUsd?: number;
}

export interface AgentRunConfig extends AgentRunRepoConfig {
  /** Command to run instead of the bundled default harness. */
  harnessCommand?: string;
  /**
   * Model the harness asks for, and the provider to route it through when the
   * id alone is ambiguous. Recorded on the run either way, so two runs of the
   * same issue can be compared by what actually drove them.
   */
  model?: string;
  provider?: string;
  limits?: AgentRunLimits;
  /** Leave the diff on disk; do not push and do not open a PR. */
  dryRun?: boolean;
}

export class AgentRunEvent {
  id: string;
  createdAt: Date;
  at: Date;
  level: AgentRunEventLevel;
  message: string;
  phase: string | null;
  data: unknown;
  runId: string;
}

export class AgentRunIteration {
  id: string;
  createdAt: Date;
  runId: string;
  index: number;
  validationPassRate: number | null;
  heldOutPassRate: number | null;
  delta: number | null;
  verificationPassed: boolean | null;
  findings: unknown;
  diffHash: string | null;
  phaseTimings: AgentRunPhaseTimings | null;
}

export class AgentRun {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  workspaceId: string;
  issueId: string;
  agentUserId: string;
  createdById: string | null;

  executor: string;
  status: AgentRunStatus;
  attempt: number;
  previousRunId: string | null;

  leaseExpiresAt: Date | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;

  summary: string | null;
  error: string | null;
  failure: AgentRunFailure | null;

  result: AgentRunResult | null;
  config: AgentRunConfig | null;
  contextPack: unknown;

  harnessVersion: string | null;
  modelId: string | null;
  configHash: string | null;
  iterationCount: number;
  phaseTimings: AgentRunPhaseTimings | null;
  baseCommit: string | null;

  events?: AgentRunEvent[];
  iterations?: AgentRunIteration[];
}
