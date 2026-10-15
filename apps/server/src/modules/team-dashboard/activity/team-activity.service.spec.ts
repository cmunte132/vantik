import { PrismaService } from 'nestjs-prisma';

import { TeamActivityService, noteActivity } from './team-activity.service';
import { TeamAnalysisProcessor } from './team-analysis.processor';

interface Row {
  teamId: string;
  lastActivityAt: Date | null;
  lastAnalysisAt: Date | null;
  nextAnalysisAt: Date | null;
}

type Cond = Record<string, unknown>;

/** True when `value` meets a `null`, `{ lt }` or `{ not }` condition. */
function matches(value: Date | null, cond: unknown): boolean {
  if (cond === null) {
    return value === null;
  }
  if (cond instanceof Date) {
    return value?.getTime() === cond.getTime();
  }
  const c = cond as { lt?: Date; not?: null };
  if (c.lt) {
    return value !== null && value < c.lt;
  }
  return true;
}

/** An in-memory TeamDashboardSettings table with the calls the code uses. */
function fakePrisma(initial?: Partial<Row>) {
  const rows = new Map<string, Row>();
  if (initial) {
    rows.set('t1', {
      teamId: 't1',
      lastActivityAt: null,
      lastAnalysisAt: null,
      nextAnalysisAt: null,
      ...initial,
    });
  }
  const test = (row: Row, where: Cond): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === 'teamId') {
        return row.teamId === cond;
      }
      if (key === 'OR') {
        return (cond as Cond[]).some((alt) => test(row, alt));
      }
      return matches(row[key as keyof Row] as Date | null, cond);
    });

  const settings = {
    findUnique: jest.fn(async ({ where }): Promise<Row | null> =>
      rows.has(where.teamId) ? { ...rows.get(where.teamId)! } : null,
    ),
    count: jest.fn(async ({ where }) => (rows.has(where.teamId) ? 1 : 0)),
    create: jest.fn(async ({ data }) => {
      if (rows.has(data.teamId)) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      rows.set(data.teamId, {
        lastActivityAt: null,
        lastAnalysisAt: null,
        nextAnalysisAt: null,
        ...data,
      });
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      let count = 0;
      for (const row of rows.values()) {
        if (test(row, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    }),
    update: jest.fn(async ({ where, data }) => {
      Object.assign(rows.get(where.teamId), data);
    }),
  };
  return { prisma: { teamDashboardSettings: settings }, rows, settings };
}

function build(initial?: Partial<Row>) {
  const db = fakePrisma(initial);
  const queue = {
    add: jest.fn(
      async (name: string, data: unknown, options: unknown): Promise<void> => {
        void [name, data, options];
      },
    ),
    getJob: jest.fn(async (id: string) => {
      void id;
      return { remove: jest.fn(async (): Promise<void> => undefined) } as {
        remove: jest.Mock;
      } | null;
    }),
  };
  const service = new TeamActivityService(
    db.prisma as unknown as PrismaService,
    queue as never,
  );
  return { ...db, queue, service };
}

const HOUR = 3_600_000;

describe('TeamActivityService', () => {
  afterEach(() => {
    delete process.env.TEAM_DASHBOARD_ANALYSIS;
    delete process.env.TEAM_DASHBOARD_ANALYSIS_INTERVAL_MINUTES;
  });

  it('coalesces a burst into one queued job', async () => {
    const { service, queue, rows } = build();

    await Promise.all(Array.from({ length: 10 }, () => service.record('t1')));

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, options] = queue.add.mock.calls[0] as unknown as [
      string,
      unknown,
      { jobId: string; attempts: number; delay: number },
    ];
    expect(name).toBe('analyzeTeam');
    expect(data).toMatchObject({ teamId: 't1' });
    expect(options.attempts).toBe(1);
    expect(options.jobId).toBe(
      `analyzeTeam:t1:${rows.get('t1')!.nextAnalysisAt!.getTime()}`,
    );
    expect(rows.get('t1')!.lastActivityAt).not.toBeNull();
  });

  it('adds no job while one is scheduled', async () => {
    const { service, queue } = build({
      nextAnalysisAt: new Date(Date.now() + HOUR),
    });

    await service.record('t1');

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('claims again when the scheduled job is more than an hour overdue', async () => {
    const { service, queue } = build({
      nextAnalysisAt: new Date(Date.now() - 2 * HOUR),
    });

    await service.record('t1');

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('delays the job until an interval after the last analysis', async () => {
    const { service, queue } = build({
      lastAnalysisAt: new Date(Date.now() - 30 * 60_000),
    });

    await service.record('t1');

    const options = (queue.add.mock.calls[0] as unknown[])[2] as {
      delay: number;
    };
    // 120 minutes minus the 30 that passed.
    expect(options.delay).toBeGreaterThan(89 * 60_000);
    expect(options.delay).toBeLessThanOrEqual(90 * 60_000);
  });

  it('does not rewrite the activity time inside the debounce window', async () => {
    const recent = new Date(Date.now() - 10_000);
    const { service, rows } = build({ lastActivityAt: recent });

    await service.record('t1');

    expect(rows.get('t1')!.lastActivityAt).toBe(recent);
  });

  it('does nothing when the analysis is off', async () => {
    process.env.TEAM_DASHBOARD_ANALYSIS = 'off';
    const { service, queue, settings } = build();

    await service.record('t1');

    expect(queue.add).not.toHaveBeenCalled();
    expect(settings.updateMany).not.toHaveBeenCalled();
    expect(settings.create).not.toHaveBeenCalled();
  });

  it('gives the claim back when the queue fails, and does not throw', async () => {
    const { service, queue, rows } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.record('t1')).resolves.toBeUndefined();

    expect(rows.get('t1')!.nextAnalysisAt).toBeNull();
  });
  it('removes the old job when it reclaims a lost claim', async () => {
    const old = new Date(Date.now() - 2 * HOUR);
    const { service, queue } = build({ nextAnalysisAt: old });

    await service.record('t1');

    expect(queue.getJob).toHaveBeenCalledWith(
      `analyzeTeam:t1:${old.getTime()}`,
    );
    const job = await queue.getJob.mock.results[0].value;
    expect(job.remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('retries a claim built on a stale lastAnalysisAt and schedules after the fresh run', async () => {
    const { service, queue, rows, settings } = build({});
    const fresh = new Date();
    // A run ends between the read and the claim.
    const read = settings.findUnique.getMockImplementation()!;
    settings.findUnique.mockImplementationOnce(async (args) => {
      const result = await read(args);
      rows.get('t1')!.lastAnalysisAt = fresh;
      return result;
    });

    await service.ensureScheduled('t1');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const options = (queue.add.mock.calls[0] as unknown[])[2] as {
      delay: number;
    };
    expect(options.delay).toBeGreaterThan(119 * 60_000);
  });
});

describe('noteActivity', () => {
  it('swallows a record() that rejects or throws', async () => {
    const rejecting = { record: jest.fn().mockRejectedValue(new Error('x')) };
    const throwing = {
      record: jest.fn(() => {
        throw new Error('y');
      }),
    };

    expect(() => noteActivity(rejecting, 't1')).not.toThrow();
    expect(() => noteActivity(throwing, 't1')).not.toThrow();
    expect(() => noteActivity(undefined, 't1')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejecting.record).toHaveBeenCalledWith('t1');
  });
});

describe('TeamAnalysisProcessor', () => {
  function processor(initial: Partial<Row>, analyze = jest.fn()) {
    const { prisma, rows, queue, service } = build(initial);
    const analysis = { analyzeTeam: analyze };
    const proc = new TeamAnalysisProcessor(
      prisma as unknown as PrismaService,
      service,
      analysis as never,
    );
    return { proc, rows, queue, analyze };
  }

  it('schedules the next run one interval later when the team was active', async () => {
    const previous = new Date(Date.now() - 3 * HOUR);
    const { proc, rows, queue } = processor({
      lastAnalysisAt: previous,
      lastActivityAt: new Date(Date.now() - HOUR),
      nextAnalysisAt: new Date(),
    });

    await proc.processTeam('t1');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const options = (queue.add.mock.calls[0] as unknown[])[2] as {
      delay: number;
    };
    expect(options.delay).toBeGreaterThan(119 * 60_000);
    expect(rows.get('t1')!.nextAnalysisAt).not.toBeNull();
    expect(rows.get('t1')!.lastAnalysisAt!.getTime()).toBeGreaterThan(
      previous.getTime(),
    );
  });

  it('schedules a second run after the first ever run when there was activity', async () => {
    const { proc, queue } = processor({
      lastActivityAt: new Date(Date.now() - HOUR),
      nextAnalysisAt: new Date(),
    });

    await proc.processTeam('t1');

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('stops the chain when nothing happened since the last run', async () => {
    const { proc, rows, queue } = processor({
      lastAnalysisAt: new Date(Date.now() - 3 * HOUR),
      lastActivityAt: new Date(Date.now() - 5 * HOUR),
      nextAnalysisAt: new Date(),
    });

    await proc.processTeam('t1');

    expect(queue.add).not.toHaveBeenCalled();
    expect(rows.get('t1')!.nextAnalysisAt).toBeNull();
  });

  it('clears the claim when the analysis throws', async () => {
    const { proc, rows } = processor(
      {
        lastAnalysisAt: new Date(Date.now() - 3 * HOUR),
        lastActivityAt: new Date(Date.now() - 5 * HOUR),
        nextAnalysisAt: new Date(),
      },
      jest.fn().mockRejectedValue(new Error('model down')),
    );

    await expect(proc.processTeam('t1')).resolves.toBeUndefined();

    expect(rows.get('t1')!.nextAnalysisAt).toBeNull();
    expect(rows.get('t1')!.lastAnalysisAt).not.toBeNull();
  });

  it('skips a superseded job and keeps the newer claim', async () => {
    const claim = new Date(Date.now() + HOUR);
    const { proc, rows, analyze } = processor({
      lastActivityAt: new Date(),
      nextAnalysisAt: claim,
    });

    await proc.processTeam('t1', claim.getTime() - 5000);

    expect(analyze).not.toHaveBeenCalled();
    expect(rows.get('t1')!.nextAnalysisAt).toBe(claim);
    expect(rows.get('t1')!.lastAnalysisAt).toBeNull();
  });

  it('clears only its own claim', async () => {
    const claim = new Date(Date.now() - 1000);
    const newer = new Date(Date.now() + HOUR);
    const analyze = jest.fn(async () => {
      // A newer claim lands while the analysis runs.
      rows.get('t1')!.nextAnalysisAt = newer;
    });
    const { proc, rows } = processor(
      {
        lastActivityAt: new Date(Date.now() - 5 * HOUR),
        nextAnalysisAt: claim,
      },
      analyze,
    );
    rows.get('t1')!.lastAnalysisAt = new Date(Date.now() - 3 * HOUR);

    await proc.processTeam('t1', claim.getTime());

    expect(rows.get('t1')!.nextAnalysisAt).toBe(newer);
    expect(rows.get('t1')!.lastAnalysisAt!.getTime()).toBeGreaterThan(
      Date.now() - 5000,
    );
  });
});
