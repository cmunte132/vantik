/** The queue and job the stuck-issue analysis runs under. */
export const TEAM_ANALYSIS_QUEUE = 'team-dashboard-analysis';
export const ANALYZE_TEAM_JOB = 'analyzeTeam';

export interface AnalyzeTeamJob {
  teamId: string;
  /** The claimed run time (ms). A job whose time no longer matches the claim is old. */
  at: number;
}

/** Writes to the activity timestamp at most this often per team. */
export const ACTIVITY_DEBOUNCE_MS = 60_000;

/**
 * A claim older than this means the job was lost (a Redis flush, or a crash
 * before the job ran), so the next activity may claim again.
 */
export const LOST_JOB_MS = 60 * 60_000;

/** `TEAM_DASHBOARD_ANALYSIS=off` stops recording and scheduling. */
export function analysisEnabled(): boolean {
  return (
    (process.env.TEAM_DASHBOARD_ANALYSIS ?? '').trim().toLowerCase() !== 'off'
  );
}

/** The time between two analyses of one team. Default: 2 hours. */
export function analysisIntervalMs(): number {
  const minutes = Number(process.env.TEAM_DASHBOARD_ANALYSIS_INTERVAL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 120) * 60_000;
}

/** The most issues one run sends to the model. Default: 20. */
export function analysisMaxIssues(): number {
  const max = Number(process.env.TEAM_DASHBOARD_ANALYSIS_MAX_ISSUES);
  return Number.isInteger(max) && max > 0 ? max : 20;
}
