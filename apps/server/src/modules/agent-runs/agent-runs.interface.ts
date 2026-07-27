/**
 * How long a claim is good for before the run is considered abandoned.
 *
 * Long enough that a runner doing real work — cloning a large repo, installing
 * dependencies — is not evicted mid-setup, short enough that a laptop that
 * closed its lid does not hold a queued issue hostage for an hour. The runner
 * renews well inside this on every heartbeat, so the only way to reach it is
 * to have genuinely stopped.
 */
export const AGENT_RUN_LEASE_MS = Number(
  process.env.AGENT_RUN_LEASE_MS ?? 5 * 60 * 1000,
);

/**
 * How often the sweeper looks for lapsed leases.
 *
 * Bull repeatable jobs take a cron expression, whose finest granularity is a
 * minute — which is fine here, since the lease is measured in minutes and a
 * run sitting expired for up to sixty seconds longer than necessary costs
 * nothing.
 */
export const AGENT_RUN_LEASE_SWEEP_CRON =
  process.env.AGENT_RUN_LEASE_SWEEP_CRON ?? '* * * * *';

/**
 * How many times a run is retried automatically before a person has to look.
 *
 * Counts total attempts, not retries. Three is the point past which a fourth
 * identical attempt is not new information — the same environment failing the
 * same way is a broken config, not bad luck, and burning model budget to prove
 * it again helps nobody.
 */
export const AGENT_RUN_MAX_ATTEMPTS = Number(
  process.env.AGENT_RUN_MAX_ATTEMPTS ?? 3,
);

/**
 * Most runs a single workspace may have in flight at once.
 *
 * A cap the server enforces rather than a convention the clients honour: a
 * scripted loop that delegates every issue in a backlog is a plausible
 * accident, and its cost lands on whoever holds the model key.
 */
export const AGENT_RUN_WORKSPACE_CONCURRENCY = Number(
  process.env.AGENT_RUN_WORKSPACE_CONCURRENCY ?? 5,
);

/**
 * Events kept per run.
 *
 * A chatty harness emits thousands of lines, and the value of the oldest ones
 * falls off a cliff once a run has moved on. Trimming keeps the tail cheap to
 * read and the table from becoming the largest thing in the database; the
 * summary and the typed failure category are what survive a run, not its log.
 */
export const AGENT_RUN_EVENT_CAP = Number(
  process.env.AGENT_RUN_EVENT_CAP ?? 2000,
);

/** How many events over the cap accumulate before a trim runs. */
export const AGENT_RUN_EVENT_TRIM_SLACK = 200;

/** The queue and job the lease sweep runs under. */
export const AGENT_RUNS_QUEUE = 'agent-runs';
export const AGENT_RUN_LEASE_SWEEP_JOB = 'sweepAgentRunLeases';

/**
 * A fixed id for the repeatable job, so every replica registering the schedule
 * at boot ends up with one copy rather than one each.
 */
export const AGENT_RUN_LEASE_SWEEP_JOB_ID = 'agent-run-lease-sweep';

/**
 * Injection token for the delegation service.
 *
 * A string rather than the class, so `issues.service.ts` can resolve it
 * without importing the class as a *value*. That import would create a
 * file-level require cycle — issues → delegation → issue-comments → issues —
 * and one of the three evaluates to undefined, which surfaces as Nest failing
 * to resolve a dependency that is plainly declared.
 */
export const AGENT_DELEGATION_SERVICE = 'AGENT_DELEGATION_SERVICE';
