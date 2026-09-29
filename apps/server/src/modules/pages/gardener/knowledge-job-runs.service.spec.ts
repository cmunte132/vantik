import { PrismaService } from 'nestjs-prisma';

import KnowledgeJobRunsService, {
  triggerOf,
} from './knowledge-job-runs.service';

function harness() {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    knowledgeJobRun: {
      create: jest.fn(async ({ data }) => {
        const created = { id: `run-${rows.length + 1}`, ...data };
        rows.push(created);
        return { id: created.id };
      }),
      update: jest.fn(async ({ where, data }) => {
        const found = rows.find((candidate) => candidate.id === where.id);
        Object.assign(found ?? {}, data);
        return found;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const before = rows.length;
        const kept = rows.filter(
          (candidate) =>
            (candidate.startedAt as Date).getTime() >=
            where.startedAt.lt.getTime(),
        );
        rows.splice(0, rows.length, ...kept);
        return { count: before - kept.length };
      }),
    },
    pageEntry: {
      findUnique: jest.fn(async () => ({ workspaceId: 'ws-of-entry' })),
    },
    agentRun: {
      findUnique: jest.fn(async () => ({ workspaceId: 'ws-of-run' })),
    },
  } as unknown as PrismaService;

  return { service: new KnowledgeJobRunsService(prisma), rows, prisma };
}

describe('recording the runs of gardener jobs', () => {
  it('records a run with its trigger, timing and what it counted', async () => {
    const { service, rows } = harness();

    const result = await service.record(
      'runDecay',
      { opts: { repeat: { cron: '0 3 * * *' } }, attemptsMade: 0 },
      {},
      async () => ({ archivedStanding: 4, observed: 0 }),
    );

    expect(result).toEqual({ archivedStanding: 4, observed: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job: 'runDecay',
      trigger: 'SCHEDULE',
      workspaceId: null,
      attempt: 1,
      counts: { archivedStanding: 4, observed: 0 },
    });
    expect(rows[0].finishedAt).toBeInstanceOf(Date);
    expect(typeof rows[0].durationMs).toBe('number');
    expect(rows[0].error).toBeUndefined();
  });

  it('records the workspace of the entry or run a job is about', async () => {
    const { service, rows } = harness();

    await service.record(
      'triageEntry',
      { attemptsMade: 1 },
      { entryId: 'entry-1' },
      async (): Promise<void> => undefined,
    );
    await service.record(
      'recordRunFindings',
      undefined,
      { agentRunId: 'run-9' },
      async (): Promise<void> => undefined,
    );

    expect(rows[0]).toMatchObject({
      workspaceId: 'ws-of-entry',
      subjectId: 'entry-1',
      trigger: 'EVENT',
      attempt: 2,
    });
    expect(rows[1]).toMatchObject({
      workspaceId: 'ws-of-run',
      subjectId: 'run-9',
    });
  });

  it('records the error of a job that fails, and throws it again for Bull', async () => {
    const { service, rows } = harness();

    await expect(
      service.record('retryUnknownCitations', undefined, {}, async () => {
        throw new Error('2 citation(s) could not be read yet');
      }),
    ).rejects.toThrow('could not be read yet');

    expect(rows[0]).toMatchObject({
      error: '2 citation(s) could not be read yet',
    });
    expect(rows[0].finishedAt).toBeInstanceOf(Date);
  });

  it('runs the job when the record cannot be written', async () => {
    const { service, prisma } = harness();
    (prisma.knowledgeJobRun.create as jest.Mock).mockRejectedValue(
      new Error('database is gone'),
    );
    const work = jest.fn(async () => ({ checked: 1 }));

    await expect(
      service.record('recheckEntryCitations', undefined, {}, work),
    ).resolves.toEqual({ checked: 1 });
    expect(work).toHaveBeenCalled();
    expect(prisma.knowledgeJobRun.update).not.toHaveBeenCalled();
  });

  it('keeps a result that is not a flat record out of the counts', async () => {
    const { service, rows } = harness();

    await service.record('x', undefined, {}, async () => ({
      nested: { no: 1 },
    }));

    expect(rows[0].counts).toBeUndefined();
  });

  it('removes the runs older than 30 days', async () => {
    const { service, rows } = harness();
    const now = new Date('2026-09-29T00:00:00Z');
    rows.push(
      { id: 'old', startedAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'new', startedAt: new Date('2026-09-20T00:00:00Z') },
    );

    await expect(service.prune(now)).resolves.toBe(1);
    expect(rows.map((candidate) => candidate.id)).toEqual(['new']);
  });
});

describe('what started a job', () => {
  it('tells a scheduled run from one at boot and one caused by an event', () => {
    expect(triggerOf('runDecay', { opts: { repeat: {} } })).toBe('SCHEDULE');
    expect(triggerOf('recomputeEntryModules', { data: {} })).toBe('BOOT');
    expect(
      triggerOf('recomputeEntryModules', { data: { workspaceId: 'ws' } }),
    ).toBe('EVENT');
    expect(triggerOf('triageEntry', { data: { entryId: 'e' } })).toBe('EVENT');
  });
});
