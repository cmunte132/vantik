/**
 * When the nightly job learns the stuck-issue thresholds. Empty or `off`
 * disables it. The service then learns a team's thresholds on first read.
 */
export const TEAM_DASHBOARD_LEARN_CRON =
  process.env.TEAM_DASHBOARD_LEARN_CRON ?? '30 2 * * *';

/** The queue and job the nightly learning runs under. */
export const TEAM_DASHBOARD_QUEUE = 'team-dashboard';
export const LEARN_THRESHOLDS_JOB = 'learnThresholds';

/**
 * A fixed id for the repeatable job. Every replica registers the schedule at
 * boot, so without a stable id each one would add its own copy.
 */
export const LEARN_THRESHOLDS_JOB_ID = 'team-dashboard-learn-thresholds';
