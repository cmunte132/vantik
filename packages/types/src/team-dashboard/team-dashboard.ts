import { IsObject } from 'class-validator';

/** Where a stuck-issue threshold came from. */
export type ThresholdSource = 'override' | 'learned' | 'default';

export interface WeeklyVelocity {
  /** ISO week label, for example 2026-W41. */
  week: string;
  /** Monday of the week, 00:00 UTC. */
  weekStart: string;
  count: number;
  points: number;
}

export interface CycleVelocity {
  cycleId: string;
  number: number;
  name: string;
  completedCount: number;
  completedPoints: number;
  totalCount: number;
  totalPoints: number;
}

export interface BurndownDay {
  /** Day, as YYYY-MM-DD in UTC. */
  date: string;
  remaining: number;
}

export interface Burndown {
  cycleId: string;
  number: number;
  name: string;
  startDate: string;
  endDate: string;
  /** Points when any issue in the cycle has an estimate, else issues. */
  unit: 'points' | 'issues';
  /** One entry per day from the start to today, or to the end if past. */
  actual: BurndownDay[];
  /** One entry per day from the start to the end of the cycle. */
  ideal: BurndownDay[];
}

export interface CycleTimeStats {
  sampleCount: number;
  medianHours: number | null;
  p80Hours: number | null;
}

export interface TeamDashboardMetrics {
  velocity: {
    weekly: WeeklyVelocity[];
    cycles: CycleVelocity[];
  };
  burndown: Burndown | null;
  cycleTime: CycleTimeStats;
}

export interface StateThreshold {
  stateId: string;
  name: string;
  hours: number;
  source: ThresholdSource;
  /** The name-based default, shown when there is nothing learned. */
  defaultHours: number;
  learnedHours: number | null;
  sampleCount: number;
  overrideHours: number | null;
}

export interface StuckIssue {
  id: string;
  number: number;
  title: string;
  assigneeId: string | null;
  stateId: string;
  /** When the issue entered its state, as an ISO timestamp. */
  stateEnteredAt: string;
  hoursInState: number;
  thresholdHours: number;
  thresholdSource: ThresholdSource;
  overageHours: number;
}

export const STUCK_CATEGORIES = [
  'waiting-on-review',
  'blocked-by-dependency',
  'unclear-scope',
  'too-large',
  'no-owner',
  'inactive',
  'other',
] as const;

export type StuckCategory = (typeof STUCK_CATEGORIES)[number];

/** The model's reading of one stuck issue. */
export interface StuckFinding {
  cause: string;
  category: StuckCategory;
  suggestions: string[];
  confidence: number | null;
  /** When the finding was written, as an ISO timestamp. */
  analyzedAt: string;
}

export interface StuckIssueWithFinding extends StuckIssue {
  /** Null while the analysis of the issue's current state is pending. */
  finding: StuckFinding | null;
}

/** The answer of GET /v1/teams/:teamId/dashboard/stuck. */
export interface StuckIssuesResponse {
  items: StuckIssueWithFinding[];
  analysis: {
    lastAnalysisAt: string | null;
    nextAnalysisAt: string | null;
  };
}

export class UpdateThresholdOverridesDto {
  /** Map of stateId to hours. A null value clears the override. */
  @IsObject()
  overrides: Record<string, number | null>;
}
