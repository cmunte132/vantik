/**
 * When the cycle maintenance pass runs. Empty or `off` disables it entirely.
 *
 * Hourly rather than nightly because a cycle's end date carries a time of day:
 * a nightly pass would leave a cycle that ended at 10am showing as current
 * until the small hours, and the team looking at a sprint it had already
 * finished.
 */
export const CYCLE_MAINTENANCE_CRON =
  process.env.CYCLE_MAINTENANCE_CRON ?? '0 * * * *';

/** The queue and job the maintenance pass runs under. */
export const CYCLES_QUEUE = 'cycles';
export const CYCLE_MAINTENANCE_JOB = 'runCycleMaintenance';

/**
 * A fixed id for the repeatable job.
 *
 * Every replica registers the schedule at boot, so without a stable id each
 * would add its own copy. Unlike an idempotent groom, a duplicated cycle pass
 * would replenish twice and produce two batches of upcoming cycles.
 */
export const CYCLE_MAINTENANCE_JOB_ID = 'cycle-maintenance';
