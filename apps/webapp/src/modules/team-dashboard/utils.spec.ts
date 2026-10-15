import { describe, expect, it } from 'vitest';

import {
  formatAgo,
  formatHours,
  formatUntil,
  niceMax,
  scaleLinear,
  shortDate,
  shortWeek,
  weeklyComparison,
} from './utils';

describe('formatHours', () => {
  it('shows hours under a day and days from a day up', () => {
    expect(formatHours(5.5)).toBe('5.5h');
    expect(formatHours(5)).toBe('5h');
    expect(formatHours(24)).toBe('1d');
    expect(formatHours(50.4)).toBe('2.1d');
  });

  it('shows a dash when there is no value', () => {
    expect(formatHours(null)).toBe('–');
    expect(formatHours(undefined)).toBe('–');
  });
});

describe('formatAgo and formatUntil', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');

  it('formats the past', () => {
    expect(formatAgo('2026-10-15T11:59:40Z', now)).toBe('just now');
    expect(formatAgo('2026-10-15T11:40:00Z', now)).toBe('20m ago');
    expect(formatAgo('2026-10-15T10:00:00Z', now)).toBe('2h ago');
    expect(formatAgo('2026-10-12T12:00:00Z', now)).toBe('3d ago');
  });

  it('formats the future', () => {
    expect(formatUntil('2026-10-15T13:40:00Z', now)).toBe('1h 40m');
    expect(formatUntil('2026-10-15T12:25:00Z', now)).toBe('25m');
    expect(formatUntil('2026-10-17T15:00:00Z', now)).toBe('2d 3h');
    expect(formatUntil('2026-10-15T11:00:00Z', now)).toBe('a moment');
  });
});

describe('weeklyComparison', () => {
  it('compares the last week with the one before', () => {
    const week = (count: number) => ({
      week: 'w',
      weekStart: 'd',
      count,
      points: 0,
    });

    expect(weeklyComparison([week(3), week(5)])).toEqual({
      current: 5,
      previous: 3,
      delta: 2,
    });
    expect(weeklyComparison([])).toEqual({ current: 0, previous: 0, delta: 0 });
  });
});

describe('chart scaling', () => {
  it('rounds an axis maximum up to a readable number', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(34)).toBe(50);
    expect(niceMax(2)).toBe(2);
  });

  it('maps a domain onto a range', () => {
    const y = scaleLinear([0, 10], [100, 0]);

    expect(y(0)).toBe(100);
    expect(y(10)).toBe(0);
    expect(y(5)).toBe(50);
    expect(scaleLinear([3, 3], [7, 9])(3)).toBe(7);
  });

  it('shortens labels', () => {
    expect(shortWeek('2026-W41')).toBe('W41');
    expect(shortDate('2026-10-12')).toBe('Oct 12');
  });
});
