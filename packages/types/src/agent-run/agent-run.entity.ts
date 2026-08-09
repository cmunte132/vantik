import type { ThinkingLevel } from './model-providers';

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
 * How a run checks its own work.
 *
 * The highest-leverage thing in the whole context pack. Whether the agent can
 * run the repo's own tests and react to the output is the difference between a
 * plausible diff and a working one — worth more than a better model.
 *
 * Configured per module, because the command depends on the code and on
 * nothing else: a workspace holding a Go service and a pnpm monorepo has no
 * single `testCommand` that is right for both. Setup is kept separate from the
 * rest because the hosted executor runs it in a different phase, with
 * different credentials and different egress.
 */
export interface AgentRunVerification {
  /** Run once, with network and install credentials. */
  setupCommands?: string[];
  /**
   * Hosts the setup commands are allowed to reach, beyond the model provider
   * and the npm registry the harness itself comes from.
   *
   * Beside the commands because it is the same decision. A hosted run's egress
   * is an allowlist fixed when the sandbox boots, and a command string cannot
   * open a hole in it — so a module that says `go mod download` has stated
   * only half of what it needs, and the other half has nowhere else to live.
   * A Go module names `proxy.golang.org` here; a pnpm one names nothing and
   * gets nothing extra.
   *
   * Deny-by-default survives: this widens one run's allowlist by exactly what
   * one module asked for, rather than growing a shared list into the union of
   * every language the product has ever met.
   */
  egressHosts?: string[];
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
}

/** Whether a module has anything to say about verifying its code. */
export function hasVerification(value: AgentRunVerification | undefined) {
  return Boolean(
    value?.testCommand ||
      value?.lintCommand ||
      value?.typecheckCommand ||
      value?.buildCommand ||
      value?.setupCommands?.length,
  );
}

/**
 * Where the code is, how to deliver the work, and how to verify it.
 *
 * Verification arrives from the issue's modules; everything else is the
 * workspace's default or the delegating caller's override.
 */
export interface AgentRunRepoConfig extends AgentRunVerification {
  /** Remote to clone. Absent for a run against a local checkout. */
  repoUrl?: string;
  /**
   * Local repository the runner works in, when there is no remote to clone.
   * The runner's own path; the server only stores it.
   */
  repoPath?: string;
  /**
   * The part of the repository this run is about, from the modules the issue
   * names. Empty or absent means the whole of it.
   *
   * Advisory, not a fence: it tells the agent where to look first in a
   * monorepo rather than making the rest of the tree unreadable. A change that
   * genuinely belongs outside these paths is a change the agent should still
   * be able to make.
   */
  pathPrefixes?: string[];
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
}

export interface AgentRunLimits {
  /** Wall-clock cap for the whole run. */
  maxDurationMs?: number;
  maxTokens?: number;
  maxIterations?: number;
  maxCostUsd?: number;
  /**
   * Passes of the implement → verify → review cycle a run may take.
   *
   * The budget denominated in the thing the cycle spends. `maxIterations`
   * counts assistant turns inside one harness invocation and cannot bound a
   * loop that starts a new invocation each pass; `maxCostUsd` bounds the money
   * but says nothing until it has been spent. This is the ceiling somebody
   * reasons about before delegating.
   */
  maxCycles?: number;
}

/**
 * Which of the review phases a run performs.
 *
 * `specify` and `score` belong to the BYO runner's loop and default off there.
 * `review` is the hosted sandbox's implement → verify → review → revise cycle,
 * and defaults **on**: an agent that grades its own work is the failure this
 * whole surface exists to avoid, and a second agent reading the diff against
 * the issue is the cheapest check available that the first one did not.
 */
export interface AgentRunPhases {
  specify?: boolean;
  score?: boolean;
  review?: boolean;
}

export interface AgentRunConfig extends AgentRunRepoConfig {
  /** Command to run instead of the bundled default harness. */
  harnessCommand?: string;
  /**
   * Model the harness asks for, and the provider to route it through.
   *
   * The provider is not decoration: it selects which of the workspace's keys
   * the run uses and which environment variable that key reaches the harness
   * under. A workspace with keys for more than one provider and a run that
   * names none is refused rather than resolved.
   *
   * Recorded on the run either way, so two runs of the same issue can be
   * compared by what actually drove them.
   */
  model?: string;
  provider?: string;
  /**
   * How hard the model is asked to think — Pi's `--thinking`. The single
   * largest lever on both cost and quality, which is why it is a first-class
   * option rather than something buried in a harness command override.
   */
  thinking?: ThinkingLevel;
  limits?: AgentRunLimits;
  /**
   * Which review phases this run performs.
   *
   * Resolved at delegation from the workspace's settings with the request's
   * choice over them, and then stored on the run — so a later change to the
   * workspace default cannot rewrite what a finished run was asked to do, and
   * "was this diff reviewed" stays answerable from the row.
   */
  phases?: AgentRunPhases;
  /** Leave the diff on disk; do not push and do not open a PR. */
  dryRun?: boolean;
}

/**
 * What a step was, as opposed to what it printed.
 *
 * The reading half of the vocabulary the harness writes. Mirrored from
 * `packages/cli/src/runner/contract.ts` rather than imported: the CLI is
 * published on its own and must not depend on this package. The consumers
 * treat an unknown kind as absent and fall back to the message, so the two
 * sides drifting costs a nicer row rather than a broken screen.
 */
/**
 * The ceilings a run is held to when nobody sets one.
 *
 * Mirrored from `BUDGET_DEFAULTS` in `packages/cli/src/runner/budget.ts`,
 * which is the authority — the runner is what actually stops a run, and it is
 * published on its own without this package. Held here so the delegation sheet
 * can state the ceiling before somebody spends it, instead of a run ending
 * with `BUDGET_EXHAUSTED` and reading as a bug.
 *
 * `run-limits.spec.ts` on the server reads the other file and fails if the two
 * disagree, so a raised ceiling cannot leave the app quoting the old number.
 */
export const AGENT_RUN_DEFAULT_LIMITS = {
  maxIterations: 50,
  maxCostUsd: 5,
} as const;

/**
 * Passes of the review cycle a hosted run takes when nobody sets a ceiling.
 *
 * Not in `AGENT_RUN_DEFAULT_LIMITS` because that block mirrors the CLI runner's
 * `BUDGET_DEFAULTS`, and the CLI enforces none of this — the cycle is the
 * hosted executor's, and a number stated as the runner's would be a number
 * nothing on that side reads.
 *
 * Three is where the evidence points. The first review catches most of what a
 * one-shot run gets wrong; by the third the loop is usually rewording rather
 * than fixing, and more search steps amplify reward hacking rather than reduce
 * it. A run that needs a fourth pass is one a person should look at.
 */
export const AGENT_RUN_DEFAULT_MAX_CYCLES = 3;

export const AGENT_STEP_KINDS = [
  'read',
  'write',
  'search',
  'bash',
  'test',
] as const;

export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

export interface AgentStepData {
  kind: AgentStepKind;
  /** The tool call, so an outcome event can be matched to the step it ends. */
  ref?: string;
  /** What it acted on: a path for read and write, a query for a search. */
  target?: string;
  command?: string;
  /** Present on an outcome event. False means the step failed. */
  ok?: boolean;
  exit?: number;
  output?: string;
  passed?: number;
  failed?: number;
}

export class AgentRunEvent {
  id: string;
  createdAt: Date;
  at: Date;
  level: AgentRunEventLevel;
  message: string;
  phase: string | null;
  data: AgentStepData | null;
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
