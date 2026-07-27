/**
 * The typed failure categories a run can end on.
 *
 * Mirrors the server's `AgentRunFailure` enum. Duplicated rather than imported
 * because the CLI ships to users who never install the server package, and a
 * runner that cannot start because a server type is missing would be a poor
 * trade for one shared constant.
 *
 * Every one of these is a different thing for the user to go and fix. That is
 * the test for whether a category earns a place: "it failed" tells someone to
 * open a log, "the push was rejected" tells them to check branch protection.
 */
export type AgentRunFailure =
  | 'ENVIRONMENT_SETUP_FAILED'
  | 'HARNESS_CRASHED'
  | 'BUDGET_EXHAUSTED'
  | 'NO_DIFF_PRODUCED'
  | 'VERIFICATION_FAILED'
  | 'PUSH_REJECTED'
  | 'PR_CREATION_FAILED'
  | 'EGRESS_DENIED'
  | 'LEASE_LOST'
  | 'NOT_TEST_SPECIFIABLE'
  | 'REWARD_HACK_SUSPECTED';

/**
 * An error carrying the category it should be reported under.
 *
 * Thrown everywhere in the runner that knows *why* something failed, so the
 * daemon's top-level handler never has to guess from a message string — which
 * is how a push rejection ends up filed as a generic crash.
 */
export class RunnerError extends Error {
  constructor(
    readonly failure: AgentRunFailure,
    message: string,
    readonly cause?: unknown,
    /**
     * What the run had spent and produced when it failed.
     *
     * Carried on the error because a failed run is the one whose cost and
     * model most need recording: "it failed" and "it failed after forty turns
     * and a dollar" are different findings, and the second is the one that
     * says whether to retry it or rewrite the issue.
     */
    readonly counters?: {
      harnessVersion?: string;
      modelId?: string;
      iterationCount?: number;
      costUsd?: number;
      summary?: string;
    },
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

/** What to tell the user, per category, when nothing more specific is known. */
export const FAILURE_ADVICE: Record<AgentRunFailure, string> = {
  ENVIRONMENT_SETUP_FAILED:
    'The checkout or the setup commands failed. Check the repo path, the base branch, and that the setup commands work from a clean clone.',
  HARNESS_CRASHED:
    'The harness exited unexpectedly. Run it by hand against the same checkout to see what it says.',
  BUDGET_EXHAUSTED:
    'The run hit its wall-clock, token or iteration limit. Raise the limit, or narrow the issue.',
  NO_DIFF_PRODUCED:
    'The harness finished without changing anything. Usually the issue does not say clearly enough what to change.',
  VERIFICATION_FAILED:
    'The repo’s own tests, typecheck or lint did not pass and the harness could not recover.',
  PUSH_REJECTED:
    'The git host refused the push. Check branch protection, whether the base is stale, and that the token can write.',
  PR_CREATION_FAILED:
    'The branch is pushed but opening the pull request failed. The work is safe; open it by hand.',
  EGRESS_DENIED:
    'The sandbox blocked a network call the run needed. Add the host to the allowlist if it is legitimate.',
  LEASE_LOST:
    'The server expired this run before it finished. The machine was probably asleep or offline.',
  NOT_TEST_SPECIFIABLE:
    'No executable test could be derived from the Definition of Done. A human should review this one.',
  REWARD_HACK_SUSPECTED:
    'The run was optimising the visible tests rather than the problem. A human should review the diff.',
};
