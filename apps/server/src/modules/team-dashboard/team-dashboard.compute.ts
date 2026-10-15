import type {
  Burndown,
  BurndownDay,
  CycleTimeStats,
  CycleVelocity,
  StateThreshold,
  StuckIssue,
  ThresholdSource,
  WeeklyVelocity,
} from '@vantikhq/types';

/**
 * Pure functions behind the team dashboard. They take plain data and a clock,
 * and they never touch Prisma, so a spec can run them on fixed histories.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export const WEEKS_OF_VELOCITY = 8;
export const CYCLES_OF_VELOCITY = 6;
export const WINDOW_DAYS = 90;

/** A learned threshold needs at least this many finished stints. */
export const MIN_LEARNING_SAMPLES = 15;
export const MIN_THRESHOLD_HOURS = 24;
export const MAX_THRESHOLD_HOURS = 720;
export const DEFAULT_THRESHOLD_HOURS = 120;
export const REVIEW_THRESHOLD_HOURS = 48;

export type StateCategory =
  'TRIAGE' | 'BACKLOG' | 'UNSTARTED' | 'STARTED' | 'COMPLETED' | 'CANCELED';

export interface StateInfo {
  id: string;
  name: string;
  category: StateCategory;
}

export interface IssueInfo {
  id: string;
  number: number;
  title: string;
  assigneeId: string | null;
  createdAt: Date;
  estimate: number | null;
  stateId: string;
  stateEnteredAt: Date;
  cycleId: string | null;
}

/**
 * Rows written before this date may hold a state move with a stale createdAt.
 * The old code merged a same-user edit into the previous row and kept its
 * createdAt, but it did bump updatedAt. So for those rows, updatedAt is the
 * move time (or later, which under-reports time in state: the safe side).
 * Newer rows get their own row per state move, so createdAt is exact.
 */
export const HISTORY_MERGE_FIX_DATE = new Date('2026-10-14T00:00:00Z');

/** The time a history row's state move happened. */
export function moveTime(row: { createdAt: Date; updatedAt: Date }): Date {
  return row.createdAt < HISTORY_MERGE_FIX_DATE ? row.updatedAt : row.createdAt;
}

/** One IssueHistory row, cut down to the columns that matter here. */
export interface StateMove {
  issueId: string;
  at: Date;
  fromStateId: string | null;
  toStateId: string | null;
}

/** A period an issue spent in one state. `end` is null while it lasts. */
export interface Stint {
  stateId: string;
  start: Date;
  end: Date | null;
}

export interface CycleInfo {
  id: string;
  number: number;
  name: string;
  startDate: Date;
  endDate: Date;
  closedAt: Date | null;
}

export interface CycleEvent {
  issueId: string;
  at: Date;
  changeType: 'ADDED' | 'MOVED' | 'UPDATED' | 'REMOVED';
}

export type CategoryOf = Map<string, StateCategory>;

export function categoryMap(states: StateInfo[]): CategoryOf {
  return new Map(states.map((state) => [state.id, state.category]));
}

/** Median is p50. Linear interpolation between ranks. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Builds the states an issue has been in, oldest first.
 *
 * A move with the same state on both sides is ignored. When the first move
 * names a state it left, the issue sat in that state from its creation.
 */
export function buildStints(
  issue: Pick<IssueInfo, 'createdAt' | 'stateId'>,
  moves: StateMove[],
): Stint[] {
  const entries = moves
    .filter((move) => move.toStateId && move.toStateId !== move.fromStateId)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (entries.length === 0) {
    return [{ stateId: issue.stateId, start: issue.createdAt, end: null }];
  }

  const stints: Stint[] = [];
  const first = entries[0];
  if (first.fromStateId) {
    stints.push({
      stateId: first.fromStateId,
      start: issue.createdAt,
      end: first.at,
    });
  }
  entries.forEach((move, index) => {
    stints.push({
      stateId: move.toStateId as string,
      start: move.at,
      end: entries[index + 1]?.at ?? null,
    });
  });
  return stints;
}

export function groupStints(
  issues: Array<Pick<IssueInfo, 'id' | 'createdAt' | 'stateId'>>,
  moves: StateMove[],
): Map<string, Stint[]> {
  const movesByIssue = new Map<string, StateMove[]>();
  for (const move of moves) {
    const list = movesByIssue.get(move.issueId) ?? [];
    list.push(move);
    movesByIssue.set(move.issueId, list);
  }
  return new Map(
    issues.map((issue) => [
      issue.id,
      buildStints(issue, movesByIssue.get(issue.id) ?? []),
    ]),
  );
}

/** The moments an issue entered a COMPLETED state, oldest first. */
function completionTimes(stints: Stint[], categoryOf: CategoryOf): Date[] {
  const times: Date[] = [];
  stints.forEach((stint, index) => {
    const previous = stints[index - 1];
    const wasComplete =
      previous && categoryOf.get(previous.stateId) === 'COMPLETED';
    if (categoryOf.get(stint.stateId) === 'COMPLETED' && !wasComplete) {
      times.push(stint.start);
    }
  });
  return times;
}

/** Monday 00:00 UTC of the week that holds the date. */
export function weekStart(date: Date): Date {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

/** ISO 8601 week label for a Monday, for example 2026-W41. */
export function isoWeekLabel(monday: Date): string {
  // The Thursday of a week decides which ISO year the week belongs to.
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Issues and points that moved into a COMPLETED state, per ISO week, for the
 * last eight weeks. An issue counts once per week, even if it was completed
 * twice in that week. An issue created in a COMPLETED state counts by its
 * creation time, because no move records it.
 */
export function weeklyVelocity(
  issues: IssueInfo[],
  stintsByIssue: Map<string, Stint[]>,
  categoryOf: CategoryOf,
  now: Date,
): WeeklyVelocity[] {
  const currentWeek = weekStart(now).getTime();
  const weeks: WeeklyVelocity[] = [];
  for (let i = WEEKS_OF_VELOCITY - 1; i >= 0; i--) {
    const start = new Date(currentWeek - i * WEEK_MS);
    weeks.push({
      week: isoWeekLabel(start),
      weekStart: start.toISOString(),
      count: 0,
      points: 0,
    });
  }
  const byStart = new Map(weeks.map((week) => [week.weekStart, week]));

  for (const issue of issues) {
    const stints = stintsByIssue.get(issue.id) ?? [];
    const seen = new Set<string>();
    for (const time of completionTimes(stints, categoryOf)) {
      const key = weekStart(time).toISOString();
      const week = byStart.get(key);
      if (!week || seen.has(key)) {
        continue;
      }
      seen.add(key);
      week.count += 1;
      week.points += issue.estimate ?? 0;
    }
  }
  return weeks;
}

/**
 * Completed work per cycle for the last six closed cycles, oldest first. An
 * issue is complete when it sits in a COMPLETED state now and still belongs to
 * the cycle. Closing a cycle moves the unfinished issues out, so what stays is
 * what the cycle delivered.
 */
export function cycleVelocity(
  cycles: CycleInfo[],
  issues: IssueInfo[],
  categoryOf: CategoryOf,
  now: Date,
): CycleVelocity[] {
  const closed = cycles
    .filter((cycle) => cycle.closedAt !== null || cycle.endDate < now)
    .sort((a, b) => b.endDate.getTime() - a.endDate.getTime())
    .slice(0, CYCLES_OF_VELOCITY)
    .reverse();

  return closed.map((cycle) => {
    const inCycle = issues.filter((issue) => issue.cycleId === cycle.id);
    const done = inCycle.filter(
      (issue) => categoryOf.get(issue.stateId) === 'COMPLETED',
    );
    return {
      cycleId: cycle.id,
      number: cycle.number,
      name: cycle.name,
      completedCount: done.length,
      completedPoints: done.reduce((sum, i) => sum + (i.estimate ?? 0), 0),
      totalCount: inCycle.length,
      totalPoints: inCycle.reduce((sum, i) => sum + (i.estimate ?? 0), 0),
    };
  });
}

function stateAt(stints: Stint[], time: Date): string | null {
  for (const stint of stints) {
    if (stint.start <= time && (stint.end === null || time < stint.end)) {
      return stint.stateId;
    }
  }
  return null;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Work left in the cycle at the end of each day.
 *
 * Scope over time comes from the cycle history: ADDED puts an issue in, and
 * MOVED or REMOVED takes it out. An issue with no history row that is in the
 * cycle now counts from its creation. Whether an issue is done on a day comes
 * from its state stints. The unit is points when any issue in scope has an
 * estimate, else issues.
 */
export function burndown(
  cycle: CycleInfo,
  issues: IssueInfo[],
  events: CycleEvent[],
  stintsByIssue: Map<string, Stint[]>,
  categoryOf: CategoryOf,
  now: Date,
): Burndown {
  const eventsByIssue = new Map<string, CycleEvent[]>();
  for (const event of events) {
    const list = eventsByIssue.get(event.issueId) ?? [];
    list.push(event);
    eventsByIssue.set(event.issueId, list);
  }
  for (const list of eventsByIssue.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  const inCycleAt = (issue: IssueInfo, time: Date): boolean => {
    const history = (eventsByIssue.get(issue.id) ?? []).filter(
      (event) => event.at <= time && event.changeType !== 'UPDATED',
    );
    if (history.length > 0) {
      return history[history.length - 1].changeType === 'ADDED';
    }
    const hasAnyEvent = (eventsByIssue.get(issue.id) ?? []).length > 0;
    // No rows at all: the issue joined before cycle history was written. This
    // is approximate for cycles that started before that change shipped. We
    // count the issue from the later of its creation and the cycle start.
    const joinedAt =
      issue.createdAt > cycle.startDate ? issue.createdAt : cycle.startDate;
    return !hasAnyEvent && issue.cycleId === cycle.id && joinedAt <= time;
  };

  const usePoints = issues.some(
    (issue) =>
      (issue.estimate ?? 0) > 0 &&
      (eventsByIssue.has(issue.id) || issue.cycleId === cycle.id),
  );
  const weight = (issue: IssueInfo) => (usePoints ? (issue.estimate ?? 0) : 1);

  const firstDay = startOfDay(cycle.startDate);
  // The end date is exclusive: the next cycle starts at it.
  const lastDay = startOfDay(new Date(cycle.endDate.getTime() - 1));
  const lastShown = startOfDay(now) < lastDay ? startOfDay(now) : lastDay;

  const remainingAt = (day: Date): number => {
    const dayEnd = new Date(day.getTime() + DAY_MS - 1);
    let total = 0;
    for (const issue of issues) {
      if (!inCycleAt(issue, dayEnd)) {
        continue;
      }
      const category = categoryOf.get(
        stateAt(stintsByIssue.get(issue.id) ?? [], dayEnd) ?? issue.stateId,
      );
      if (category !== 'COMPLETED' && category !== 'CANCELED') {
        total += weight(issue);
      }
    }
    return total;
  };

  const actual: BurndownDay[] = [];
  for (
    let day = firstDay;
    day <= lastShown;
    day = new Date(day.getTime() + DAY_MS)
  ) {
    actual.push({ date: dayKey(day), remaining: remainingAt(day) });
  }

  const dayCount = Math.round(
    (lastDay.getTime() - firstDay.getTime()) / DAY_MS,
  );
  const startScope = actual[0]?.remaining ?? 0;
  const ideal: BurndownDay[] = [];
  for (let i = 0; i <= dayCount; i++) {
    ideal.push({
      date: dayKey(new Date(firstDay.getTime() + i * DAY_MS)),
      remaining: dayCount === 0 ? 0 : round1(startScope * (1 - i / dayCount)),
    });
  }

  return {
    cycleId: cycle.id,
    number: cycle.number,
    name: cycle.name,
    startDate: cycle.startDate.toISOString(),
    endDate: cycle.endDate.toISOString(),
    unit: usePoints ? 'points' : 'issues',
    actual,
    ideal,
  };
}

/**
 * Hours from the first entry into a STARTED state to the entry into COMPLETED,
 * for issues completed in the last 90 days. An issue whose last stint is not
 * COMPLETED does not count, and neither does one that never started.
 */
export function cycleTime(
  issues: IssueInfo[],
  stintsByIssue: Map<string, Stint[]>,
  categoryOf: CategoryOf,
  now: Date,
): CycleTimeStats {
  const since = now.getTime() - WINDOW_DAYS * DAY_MS;
  const hours: number[] = [];

  for (const issue of issues) {
    const stints = stintsByIssue.get(issue.id) ?? [];
    const last = stints[stints.length - 1];
    if (!last || categoryOf.get(last.stateId) !== 'COMPLETED') {
      continue;
    }
    const completedAt = completionTimes(stints, categoryOf).pop();
    if (!completedAt || completedAt.getTime() < since) {
      continue;
    }
    const started = stints.find(
      (stint) =>
        categoryOf.get(stint.stateId) === 'STARTED' &&
        stint.start <= completedAt,
    );
    if (!started) {
      continue;
    }
    hours.push((completedAt.getTime() - started.start.getTime()) / HOUR_MS);
  }

  const median = percentile(hours, 50);
  const p80 = percentile(hours, 80);
  return {
    sampleCount: hours.length,
    medianHours: median === null ? null : round1(median),
    p80Hours: p80 === null ? null : round1(p80),
  };
}

export interface LearnedThreshold {
  /** Null when there are too few samples to learn from. */
  hours: number | null;
  sampleCount: number;
}

/**
 * For each STARTED state, learns a threshold from the stints that ended in the
 * last 90 days. With 15 or more samples it is the p80, held between 24 and 720
 * hours. With fewer, no hours are learned and the default applies.
 */
export function learnThresholds(
  states: StateInfo[],
  stintsByIssue: Map<string, Stint[]>,
  now: Date,
): Record<string, LearnedThreshold> {
  const since = now.getTime() - WINDOW_DAYS * DAY_MS;
  const samples = new Map<string, number[]>();
  for (const stints of stintsByIssue.values()) {
    for (const stint of stints) {
      if (stint.end && stint.end.getTime() >= since) {
        const list = samples.get(stint.stateId) ?? [];
        list.push((stint.end.getTime() - stint.start.getTime()) / HOUR_MS);
        samples.set(stint.stateId, list);
      }
    }
  }

  const learned: Record<string, LearnedThreshold> = {};
  for (const state of states) {
    if (state.category !== 'STARTED') {
      continue;
    }
    const list = samples.get(state.id) ?? [];
    const p80 =
      list.length >= MIN_LEARNING_SAMPLES ? percentile(list, 80) : null;
    learned[state.id] = {
      hours:
        p80 === null
          ? null
          : round1(
              Math.min(MAX_THRESHOLD_HOURS, Math.max(MIN_THRESHOLD_HOURS, p80)),
            ),
      sampleCount: list.length,
    };
  }
  return learned;
}

export function defaultThresholdHours(stateName: string): number {
  if (/progress/i.test(stateName)) {
    return DEFAULT_THRESHOLD_HOURS;
  }
  if (/review/i.test(stateName)) {
    return REVIEW_THRESHOLD_HOURS;
  }
  return DEFAULT_THRESHOLD_HOURS;
}

/** One threshold per STARTED state. An override wins over a learned value. */
export function resolveThresholds(
  states: StateInfo[],
  learned: Record<string, LearnedThreshold>,
  overrides: Record<string, number>,
): StateThreshold[] {
  return states
    .filter((state) => state.category === 'STARTED')
    .map((state) => {
      const learnedEntry = learned[state.id];
      const learnedHours = learnedEntry?.hours ?? null;
      const overrideHours = overrides[state.id] ?? null;
      let source: ThresholdSource = 'default';
      const defaultHours = defaultThresholdHours(state.name);
      let hours = defaultHours;
      if (overrideHours !== null) {
        source = 'override';
        hours = overrideHours;
      } else if (learnedHours !== null) {
        source = 'learned';
        hours = learnedHours;
      }
      return {
        stateId: state.id,
        name: state.name,
        hours,
        source,
        defaultHours,
        learnedHours,
        sampleCount: learnedEntry?.sampleCount ?? 0,
        overrideHours,
      };
    });
}

/**
 * The issues that sit in a STARTED state longer than its threshold, worst
 * first. The caller leaves out deleted issues.
 */
export function selectStuck(
  issues: IssueInfo[],
  thresholds: StateThreshold[],
  now: Date,
): StuckIssue[] {
  const byState = new Map(thresholds.map((t) => [t.stateId, t]));
  const stuck: StuckIssue[] = [];

  for (const issue of issues) {
    const threshold = byState.get(issue.stateId);
    if (!threshold) {
      continue;
    }
    const hoursInState =
      (now.getTime() - issue.stateEnteredAt.getTime()) / HOUR_MS;
    if (hoursInState <= threshold.hours) {
      continue;
    }
    stuck.push({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      assigneeId: issue.assigneeId,
      stateId: issue.stateId,
      stateEnteredAt: issue.stateEnteredAt.toISOString(),
      hoursInState: round1(hoursInState),
      thresholdHours: threshold.hours,
      thresholdSource: threshold.source,
      overageHours: round1(hoursInState - threshold.hours),
    });
  }
  return stuck.sort((a, b) => b.overageHours - a.overageHours);
}
