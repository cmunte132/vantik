/**
 * The words the app uses about a run, in one place.
 *
 * Two screens describe the same run — the panel on the issue and the workspace
 * view — and they had two copies of this vocabulary, already disagreeing:
 * `HARNESS_CRASHED` read "agent crashed" on one and "the agent crashed" with a
 * remedy on the other. A failure category is a closed set, and the whole point
 * of closing it was that every one of them says the same thing wherever it is
 * read.
 */

export const LIVE_STATUSES = ['QUEUED', 'CLAIMED', 'RUNNING'];

export function isLive(status: string): boolean {
  return LIVE_STATUSES.includes(status);
}

/** What each status means, in words rather than an enum name. */
export const STATUS_LABEL: Record<string, string> = {
  QUEUED: 'Waiting for a runner',
  CLAIMED: 'Starting',
  RUNNING: 'Working',
  SUCCEEDED: 'Done',
  FAILED: 'Could not finish',
  CANCELED: 'Stopped',
  EXPIRED: 'The runner went away',
  NEEDS_REVIEW: 'Needs a human',
};

/**
 * A failure category, said the way you would say it to someone.
 *
 * A failed run deserves as much design as a successful one — it is the half
 * everyone skips, and the half a user actually has to act on. So the app says
 * what broke and what to do, and never makes anyone open a log to find out
 * which of eleven things happened.
 *
 * `short` is the same fact with the remedy dropped, for a list row where there
 * is no room to say what to do next.
 */
export const FAILURE_PROSE: Record<
  string,
  { short: string; what: string; next: string }
> = {
  ENVIRONMENT_SETUP_FAILED: {
    short: 'environment would not build',
    what: 'the environment would not build',
    next: 'Check the repo path, base branch and setup commands.',
  },
  HARNESS_CRASHED: {
    short: 'agent crashed',
    what: 'the agent crashed',
    next: 'Try again, or run the harness by hand against the same checkout.',
  },
  BUDGET_EXHAUSTED: {
    short: 'out of budget',
    what: 'it ran out of time or budget',
    next: 'Raise the limit, or narrow the issue.',
  },
  NO_DIFF_PRODUCED: {
    short: 'changed nothing',
    what: 'it finished without changing anything',
    next: 'Usually the issue does not say clearly enough what to change.',
  },
  VERIFICATION_FAILED: {
    short: 'checks failed',
    what: 'the checks did not pass',
    next: 'Look at the branch — the work exists, it just is not green.',
  },
  PUSH_REJECTED: {
    short: 'push rejected',
    what: 'the push was rejected',
    next: 'Check branch protection and whether the base has moved.',
  },
  PR_CREATION_FAILED: {
    short: 'no pull request',
    what: 'the branch went up but the pull request did not',
    next: 'The work is safe. Open the pull request by hand.',
  },
  EGRESS_DENIED: {
    short: 'network blocked',
    what: 'the sandbox blocked a network call it needed',
    next: 'Allowlist the host if it is legitimate.',
  },
  LEASE_LOST: {
    short: 'runner went away',
    what: 'the runner stopped responding',
    next: 'The machine probably slept. Retry when it is back.',
  },
  NOT_TEST_SPECIFIABLE: {
    short: 'not test-specifiable',
    what: 'this change cannot be pinned down with tests',
    next: 'Review the diff yourself — that is expected for this kind of work.',
  },
  REWARD_HACK_SUSPECTED: {
    short: 'gaming the tests',
    what: 'it was optimising the tests rather than the problem',
    next: 'Read the diff carefully before merging any of it.',
  },
};

/** A duration in the shortest form that is still exact enough to act on. */
export function elapsed(from?: string | null, to?: string | null): string {
  if (!from) {
    return '';
  }

  const seconds = Math.max(
    0,
    Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000),
  );

  if (seconds < 60) {
    return `${seconds}s`;
  }

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * How long a run took, or nothing.
 *
 * A run that is still going is measured against now, which is what makes the
 * clock tick. A finished one is measured against the moment it finished. A
 * finished one with no `finishedAt` recorded — an older row, or one a crash
 * left half-written — gets nothing, because measuring it against now reports a
 * run from last week as having taken a week.
 */
export function duration(run: {
  status: string;
  startedAt?: string | null;
  createdAt: string;
  finishedAt?: string | null;
}): string {
  if (isLive(run.status)) {
    return elapsed(run.startedAt ?? run.createdAt);
  }

  return run.finishedAt
    ? elapsed(run.startedAt ?? run.createdAt, run.finishedAt)
    : '';
}

/** How long ago, for a list where the exact minute does not matter. */
export function age(at?: string | null): string {
  if (!at) {
    return '';
  }

  const minutes = Math.max(0, (Date.now() - Date.parse(at)) / 60000);

  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }
  if (minutes < 60 * 24) {
    return `${Math.floor(minutes / 60)}h`;
  }

  return `${Math.floor(minutes / (60 * 24))}d`;
}

/**
 * Where the finished work went.
 *
 * A pull request when there is one, otherwise the worktree to `cd` into,
 * otherwise the branch that was pushed. A run that pushed a branch without
 * opening a pull request still answers "where is the work"; naming the
 * executor instead does not.
 */
export function whereTheWorkWent(result: {
  prUrl?: string;
  worktreePath?: string;
  branch?: string;
}): { kind: 'pull_request' | 'worktree' | 'branch'; value: string } | null {
  if (result?.prUrl) {
    return { kind: 'pull_request', value: result.prUrl };
  }
  if (result?.worktreePath) {
    return { kind: 'worktree', value: result.worktreePath };
  }
  if (result?.branch) {
    return { kind: 'branch', value: result.branch };
  }

  return null;
}

/**
 * The phases a run moves through, in the order it moves through them.
 *
 * The timeline groups events under these headings. An event carrying a phase
 * the client does not know about still has to appear, so unknown phases sort
 * after these rather than being dropped.
 */
export const PHASE_ORDER = ['setup', 'specify', 'implement', 'verify', 'report'];

export const PHASE_LABEL: Record<string, string> = {
  setup: 'Setting up environment',
  specify: 'Writing the tests first',
  implement: 'Doing the work',
  verify: 'Running the checks',
  report: 'Handing the work back',
};
