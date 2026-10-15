import type { WeeklyVelocity } from '@vantikhq/types';

/** "5.5h" under a day, "2.1d" from a day up. */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) {
    return '–';
  }

  const trim = (value: number) => String(Number(value.toFixed(1)));

  return hours < 24 ? `${trim(hours)}h` : `${trim(hours / 24)}d`;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "20m ago", "2h ago", "3d ago". */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();

  if (!Number.isFinite(elapsed) || elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }

  return `${Math.floor(elapsed / DAY)}d ago`;
}

/** "1h 40m", "25m", "2d 3h", or "a moment" when the time has passed. */
export function formatUntil(iso: string, now: number = Date.now()): string {
  const remaining = new Date(iso).getTime() - now;

  if (!Number.isFinite(remaining) || remaining < MINUTE) {
    return 'a moment';
  }

  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return `${minutes}m`;
}

/** The completed count of the latest week, the week before it, and the change. */
export function weeklyComparison(weekly: WeeklyVelocity[]) {
  const current = weekly.length > 0 ? weekly[weekly.length - 1].count : 0;
  const previous = weekly.length > 1 ? weekly[weekly.length - 2].count : 0;

  return { current, previous, delta: current - previous };
}

/** A round upper bound for an axis, so ticks land on readable numbers. */
export function niceMax(value: number): number {
  if (!(value > 0)) {
    return 1;
  }

  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const fraction = value / magnitude;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;

  return step * magnitude;
}

/** Maps a value in [d0, d1] onto [r0, r1]. A flat domain maps to r0. */
export function scaleLinear(
  [d0, d1]: [number, number],
  [r0, r1]: [number, number],
) {
  return (value: number) =>
    d1 === d0 ? r0 : r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

/** "2026-W41" to "W41". */
export function shortWeek(week: string): string {
  const index = week.indexOf('-');

  return index === -1 ? week : week.slice(index + 1);
}

/** "2026-10-12" to "Oct 12", read as UTC so the day never shifts. */
export function shortDate(date: string): string {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
