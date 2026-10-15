import {
  burndown,
  buildStints,
  categoryMap,
  CycleEvent,
  CycleInfo,
  cycleTime,
  cycleVelocity,
  groupStints,
  isoWeekLabel,
  moveTime,
  IssueInfo,
  learnThresholds,
  resolveThresholds,
  selectStuck,
  StateInfo,
  StateMove,
  weeklyVelocity,
} from './team-dashboard.compute';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);
const daysAgo = (d: number) => hoursAgo(d * 24);

const STATES: StateInfo[] = [
  { id: 'todo', name: 'Todo', category: 'UNSTARTED' },
  { id: 'prog', name: 'In Progress', category: 'STARTED' },
  { id: 'rev', name: 'In Review', category: 'STARTED' },
  { id: 'wip', name: 'Doing', category: 'STARTED' },
  { id: 'done', name: 'Done', category: 'COMPLETED' },
  { id: 'cut', name: 'Canceled', category: 'CANCELED' },
];
const categoryOf = categoryMap(STATES);

function issue(over: Partial<IssueInfo> & { id: string }): IssueInfo {
  return {
    number: 1,
    title: over.id,
    assigneeId: null,
    createdAt: daysAgo(60),
    estimate: null,
    stateId: 'todo',
    stateEnteredAt: daysAgo(60),
    cycleId: null,
    ...over,
  };
}

function move(
  issueId: string,
  at: Date,
  fromStateId: string | null,
  toStateId: string | null,
): StateMove {
  return { issueId, at, fromStateId, toStateId };
}

describe('buildStints', () => {
  it('uses the current state when there are no moves', () => {
    const stints = buildStints({ createdAt: daysAgo(3), stateId: 'todo' }, []);
    expect(stints).toEqual([{ stateId: 'todo', start: daysAgo(3), end: null }]);
  });

  it('opens with the state the first move left', () => {
    const stints = buildStints({ createdAt: daysAgo(5), stateId: 'done' }, [
      move('a', daysAgo(2), 'todo', 'prog'),
      move('a', daysAgo(1), 'prog', 'done'),
    ]);
    expect(stints.map((s) => s.stateId)).toEqual(['todo', 'prog', 'done']);
    expect(stints[0].end).toEqual(daysAgo(2));
    expect(stints[2].end).toBeNull();
  });
});

describe('weeklyVelocity', () => {
  it('counts completions per ISO week with points', () => {
    const issues = [
      issue({ id: 'a', stateId: 'done', estimate: 3 }),
      issue({ id: 'b', stateId: 'done', estimate: 5 }),
      issue({ id: 'c', stateId: 'done', estimate: 2 }),
      issue({ id: 'old', stateId: 'done', estimate: 8 }),
    ];
    const moves = [
      // This week (Mon 2026-10-12).
      move('a', new Date('2026-10-13T09:00:00Z'), 'prog', 'done'),
      // Last week.
      move('b', new Date('2026-10-07T09:00:00Z'), 'prog', 'done'),
      move('c', new Date('2026-10-08T09:00:00Z'), 'prog', 'done'),
      // Far outside the eight weeks.
      move('old', new Date('2026-05-01T09:00:00Z'), 'prog', 'done'),
    ];
    const stints = groupStints(issues, moves);
    const weeks = weeklyVelocity(issues, stints, categoryOf, NOW);

    expect(weeks).toHaveLength(8);
    expect(weeks[7]).toMatchObject({ week: '2026-W42', count: 1, points: 3 });
    expect(weeks[6]).toMatchObject({ week: '2026-W41', count: 2, points: 7 });
    expect(weeks.reduce((sum, w) => sum + w.count, 0)).toBe(3);
  });

  it('counts an issue created complete by its creation time', () => {
    const issues = [
      issue({
        id: 'x',
        stateId: 'done',
        createdAt: new Date('2026-10-13T08:00:00Z'),
        estimate: 1,
      }),
    ];
    const weeks = weeklyVelocity(
      issues,
      groupStints(issues, []),
      categoryOf,
      NOW,
    );
    expect(weeks[7].count).toBe(1);
  });

  it('labels ISO weeks across a year boundary', () => {
    expect(isoWeekLabel(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekLabel(new Date('2026-10-12T00:00:00Z'))).toBe('2026-W42');
  });
});

describe('cycleVelocity', () => {
  it('takes the last six closed cycles, oldest first', () => {
    const cycles: CycleInfo[] = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i + 1}`,
      number: i + 1,
      name: `Cycle ${i + 1}`,
      startDate: daysAgo(100 - i * 10),
      endDate: daysAgo(90 - i * 10),
      closedAt: daysAgo(90 - i * 10),
    }));
    // An open cycle in the future must not appear.
    cycles.push({
      id: 'open',
      number: 9,
      name: 'Open',
      startDate: daysAgo(1),
      endDate: new Date(NOW.getTime() + 7 * 24 * HOUR),
      closedAt: null,
    });
    const issues = [
      issue({ id: 'a', cycleId: 'c8', stateId: 'done', estimate: 3 }),
      issue({ id: 'b', cycleId: 'c8', stateId: 'prog', estimate: 5 }),
    ];
    const result = cycleVelocity(cycles, issues, categoryOf, NOW);

    expect(result.map((r) => r.number)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(result[5]).toMatchObject({
      completedCount: 1,
      completedPoints: 3,
      totalCount: 2,
      totalPoints: 8,
    });
  });
});

describe('burndown', () => {
  const cycle: CycleInfo = {
    id: 'cy',
    number: 4,
    name: 'Cycle 4',
    startDate: new Date('2026-10-12T00:00:00Z'),
    endDate: new Date('2026-10-16T00:00:00Z'),
    closedAt: null,
  };
  const events: CycleEvent[] = [
    { issueId: 'a', at: new Date('2026-10-12T01:00:00Z'), changeType: 'ADDED' },
    { issueId: 'b', at: new Date('2026-10-12T01:00:00Z'), changeType: 'ADDED' },
    // Added on day 2, so scope grows.
    { issueId: 'c', at: new Date('2026-10-13T10:00:00Z'), changeType: 'ADDED' },
    // Removed on day 2.
    { issueId: 'd', at: new Date('2026-10-12T01:00:00Z'), changeType: 'ADDED' },
    {
      issueId: 'd',
      at: new Date('2026-10-13T11:00:00Z'),
      changeType: 'REMOVED',
    },
  ];

  it('burns down in points with scope changes', () => {
    const issues = [
      issue({ id: 'a', cycleId: 'cy', stateId: 'done', estimate: 3 }),
      issue({ id: 'b', cycleId: 'cy', stateId: 'prog', estimate: 5 }),
      issue({ id: 'c', cycleId: 'cy', stateId: 'prog', estimate: 2 }),
      issue({ id: 'd', cycleId: null, stateId: 'todo', estimate: 4 }),
    ];
    const moves = [move('a', new Date('2026-10-13T15:00:00Z'), 'prog', 'done')];
    const result = burndown(
      cycle,
      issues,
      events,
      groupStints(issues, moves),
      categoryOf,
      NOW,
    );

    expect(result.unit).toBe('points');
    // Day 0: a(3) + b(5) + d(4). Day 1: a done, c added, d removed: b + c.
    expect(result.actual).toEqual([
      { date: '2026-10-12', remaining: 12 },
      { date: '2026-10-13', remaining: 7 },
      { date: '2026-10-14', remaining: 7 },
    ]);
    expect(result.ideal.map((d) => d.date)).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
    expect(result.ideal[0].remaining).toBe(12);
    expect(result.ideal[3].remaining).toBe(0);
  });

  it('gives a 14 day cycle 14 ideal points ending at 0', () => {
    const long: CycleInfo = {
      ...cycle,
      startDate: new Date('2026-10-12T00:00:00Z'),
      endDate: new Date('2026-10-26T00:00:00Z'),
    };
    const issues = [
      issue({ id: 'a', cycleId: 'cy', stateId: 'prog', estimate: 4 }),
    ];
    const result = burndown(
      long,
      issues,
      [],
      groupStints(issues, []),
      categoryOf,
      NOW,
    );
    expect(result.ideal).toHaveLength(14);
    expect(result.ideal[0].remaining).toBe(4);
    expect(result.ideal[13]).toEqual({ date: '2026-10-25', remaining: 0 });
  });

  it('counts an issue with no history from the cycle start', () => {
    const issues = [
      issue({
        id: 'a',
        cycleId: 'cy',
        stateId: 'prog',
        createdAt: daysAgo(60),
      }),
    ];
    const result = burndown(
      cycle,
      issues,
      [],
      groupStints(issues, []),
      categoryOf,
      NOW,
    );
    expect(result.actual.map((d) => d.remaining)).toEqual([1, 1, 1]);
  });

  it('adds a mid-cycle ADDED issue and drops a REMOVED one', () => {
    const issues = [
      issue({ id: 'a', cycleId: 'cy', stateId: 'prog' }),
      issue({ id: 'late', cycleId: 'cy', stateId: 'prog' }),
      issue({ id: 'gone', cycleId: null, stateId: 'prog' }),
    ];
    const ev = (
      issueId: string,
      at: string,
      changeType: CycleEvent['changeType'],
    ): CycleEvent => ({
      issueId,
      at: new Date(at),
      changeType,
    });
    const result = burndown(
      cycle,
      issues,
      [
        ev('a', '2026-10-12T01:00:00Z', 'ADDED'),
        ev('gone', '2026-10-12T01:00:00Z', 'ADDED'),
        ev('late', '2026-10-13T10:00:00Z', 'ADDED'),
        ev('gone', '2026-10-14T01:00:00Z', 'REMOVED'),
      ],
      groupStints(issues, []),
      categoryOf,
      NOW,
    );
    expect(result.actual.map((d) => d.remaining)).toEqual([2, 3, 2]);
  });

  it('falls back to issue counts when nothing has an estimate', () => {
    const issues = [
      issue({ id: 'a', cycleId: 'cy', stateId: 'prog' }),
      issue({ id: 'b', cycleId: 'cy', stateId: 'prog' }),
    ];
    const result = burndown(
      cycle,
      issues,
      events.filter((e) => e.issueId === 'a' || e.issueId === 'b'),
      groupStints(issues, []),
      categoryOf,
      NOW,
    );
    expect(result.unit).toBe('issues');
    expect(result.actual[0].remaining).toBe(2);
  });
});

describe('cycleTime', () => {
  it('measures first started to completed, over the last 90 days', () => {
    const issues = [
      issue({ id: 'a', stateId: 'done' }),
      issue({ id: 'b', stateId: 'done' }),
      issue({ id: 'c', stateId: 'done' }),
      issue({ id: 'stale', stateId: 'done' }),
      issue({ id: 'open', stateId: 'prog' }),
    ];
    const moves = [
      move('a', daysAgo(10), 'todo', 'prog'),
      move('a', daysAgo(9), 'prog', 'done'), // 24h
      move('b', daysAgo(10), 'todo', 'prog'),
      move('b', daysAgo(8), 'prog', 'done'), // 48h
      move('c', daysAgo(10), 'todo', 'prog'),
      move('c', daysAgo(7), 'prog', 'done'), // 72h
      move('stale', daysAgo(200), 'todo', 'prog'),
      move('stale', daysAgo(199), 'prog', 'done'),
      move('open', daysAgo(5), 'todo', 'prog'),
    ];
    const stats = cycleTime(
      issues,
      groupStints(issues, moves),
      categoryOf,
      NOW,
    );
    expect(stats.sampleCount).toBe(3);
    expect(stats.medianHours).toBe(48);
    // p80 by linear interpolation of [24, 48, 72] at rank 1.6.
    expect(stats.p80Hours).toBe(62.4);
  });

  it('returns nulls without samples', () => {
    expect(cycleTime([], new Map(), categoryOf, NOW)).toEqual({
      sampleCount: 0,
      medianHours: null,
      p80Hours: null,
    });
  });
});

describe('thresholds', () => {
  /** n issues that each spent `hours` in the state, ending recently. */
  function stintsFor(stateId: string, n: number, hours: number) {
    const issues: IssueInfo[] = [];
    const moves: StateMove[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${stateId}-${i}`;
      issues.push(issue({ id, stateId: 'done' }));
      moves.push(move(id, hoursAgo(24 + hours), 'todo', stateId));
      moves.push(move(id, hoursAgo(24), stateId, 'done'));
    }
    return groupStints(issues, moves);
  }

  it('learns the p80 with 15 or more samples', () => {
    const learned = learnThresholds(STATES, stintsFor('prog', 15, 100), NOW);
    expect(learned.prog).toEqual({ hours: 100, sampleCount: 15 });
  });

  it('learns nothing with fewer than 15 samples', () => {
    const learned = learnThresholds(STATES, stintsFor('prog', 14, 100), NOW);
    expect(learned.prog).toEqual({ hours: null, sampleCount: 14 });
  });

  it('clamps to 24 and 720 hours', () => {
    expect(
      learnThresholds(STATES, stintsFor('prog', 15, 2), NOW).prog.hours,
    ).toBe(24);
    expect(
      learnThresholds(STATES, stintsFor('prog', 15, 5000), NOW).prog.hours,
    ).toBe(720);
  });

  it('ignores stints that ended before the 90 day window', () => {
    const issues = [issue({ id: 'a', stateId: 'done' })];
    const moves = [
      move('a', daysAgo(200), 'todo', 'prog'),
      move('a', daysAgo(150), 'prog', 'done'),
    ];
    const learned = learnThresholds(STATES, groupStints(issues, moves), NOW);
    expect(learned.prog.sampleCount).toBe(0);
  });

  it('falls back to defaults by state name', () => {
    const result = resolveThresholds(STATES, {}, {});
    const byId = Object.fromEntries(result.map((r) => [r.stateId, r]));
    expect(byId.prog).toMatchObject({ hours: 120, source: 'default' });
    expect(byId.rev).toMatchObject({ hours: 48, source: 'default' });
    expect(byId.wip).toMatchObject({ hours: 120, source: 'default' });
    expect(result.map((r) => r.stateId)).toEqual(['prog', 'rev', 'wip']);
  });

  it('prefers learned over default, and an override over both', () => {
    const learned = { prog: { hours: 200, sampleCount: 20 } };
    const result = resolveThresholds(STATES, learned, { prog: 10, rev: 30 });
    const byId = Object.fromEntries(result.map((r) => [r.stateId, r]));
    expect(byId.prog).toMatchObject({
      defaultHours: 120,
      hours: 10,
      source: 'override',
      learnedHours: 200,
      overrideHours: 10,
      sampleCount: 20,
    });
    expect(byId.rev).toMatchObject({
      hours: 30,
      source: 'override',
      defaultHours: 48,
    });

    const learnedOnly = resolveThresholds(STATES, learned, {});
    expect(learnedOnly[0]).toMatchObject({ hours: 200, source: 'learned' });
  });
});

describe('selectStuck', () => {
  it('lists started issues past their threshold, worst first', () => {
    const thresholds = resolveThresholds(STATES, {}, { prog: 100 });
    const issues = [
      issue({ id: 'fresh', stateId: 'prog', stateEnteredAt: hoursAgo(10) }),
      issue({ id: 'late', stateId: 'prog', stateEnteredAt: hoursAgo(150) }),
      issue({ id: 'worst', stateId: 'rev', stateEnteredAt: hoursAgo(300) }),
      issue({ id: 'idle', stateId: 'todo', stateEnteredAt: hoursAgo(900) }),
    ];
    const stuck = selectStuck(issues, thresholds, NOW);

    expect(stuck.map((s) => s.id)).toEqual(['worst', 'late']);
    expect(stuck[0]).toMatchObject({
      thresholdHours: 48,
      thresholdSource: 'default',
      hoursInState: 300,
      overageHours: 252,
    });
    expect(stuck[1]).toMatchObject({
      thresholdHours: 100,
      thresholdSource: 'override',
      overageHours: 50,
    });
  });
});

describe('moveTime', () => {
  it('uses updatedAt for a merged row written before the fix', () => {
    // One old row: created Oct 1, then the same user moved it on Oct 5.
    const row = {
      createdAt: new Date('2026-10-01T09:00:00Z'),
      updatedAt: new Date('2026-10-05T09:00:00Z'),
    };
    expect(moveTime(row)).toEqual(row.updatedAt);

    const issues = [
      issue({ id: 'm', stateId: 'prog', createdAt: row.createdAt }),
    ];
    const stints = groupStints(issues, [
      {
        issueId: 'm',
        at: moveTime(row),
        fromStateId: 'todo',
        toStateId: 'prog',
      },
    ]);
    expect(stints.get('m')?.[1].start).toEqual(row.updatedAt);
  });

  it('uses createdAt for rows written after the fix', () => {
    const row = {
      createdAt: new Date('2026-10-14T09:00:00Z'),
      updatedAt: new Date('2026-10-14T09:30:00Z'),
    };
    expect(moveTime(row)).toEqual(row.createdAt);
  });
});
