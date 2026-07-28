/**
 * Changes made while the server was down have to reach clients afterwards.
 *
 * The replication slot is dropped and recreated on every start, so the
 * write-ahead log covering the downtime window is gone before the listener
 * attaches. Anything written in that window produces no sync action, and a
 * record with no sync action never reaches a client — not eventually, ever,
 * because the only thing that reaches a client is a sync action with a
 * sequence higher than the one it holds.
 */
import { PrismaService } from 'nestjs-prisma';

import { SyncRepairService, nextSequence } from './sync-repair.service';

const WORKSPACE = 'workspace-1';
const TEAM = 'team-1';
const CUTOFF = new Date('2026-07-27T10:00:00.000Z');
const AFTER = new Date('2026-07-27T11:00:00.000Z');

interface FakeIssue {
  id: string;
  updatedAt: Date;
  deleted: Date | null;
}

interface Written {
  modelId: string;
  action: string;
  sequenceId: bigint;
  teamId: string | null;
}

function buildService(options: {
  issues: FakeIssue[];
  announced: Array<{ modelId: string; action: string }>;
  emptyLog?: boolean;
}) {
  const written: Written[] = [];

  const prisma = {
    syncAction: {
      aggregate: jest.fn(() =>
        Promise.resolve({
          _max: options.emptyLog
            ? { createdAt: null, sequenceId: null }
            : { createdAt: CUTOFF, sequenceId: 100n },
        }),
      ),
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          where.modelName === 'Issue'
            ? options.announced
                .filter((row) => row.action !== 'D')
                .map((row) => ({ modelId: row.modelId }))
            : [],
        ),
      ),
      // Two callers with two different questions: the workspace of a record
      // that was announced at all, and the team an announcement already
      // carries for a record that has vanished.
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(
          options.announced.some((row) => row.modelId === where.modelId)
            ? where.teamId
              ? { teamId: TEAM }
              : { workspaceId: WORKSPACE }
            : null,
        ),
      ),
      upsert: jest.fn(({ create }) => {
        written.push({
          modelId: create.modelId,
          action: create.action,
          sequenceId: create.sequenceId,
          teamId: create.teamId,
        });
        return Promise.resolve(create);
      }),
    },
    issue: {
      // `getTeamId` reads the team off the record while the record is there.
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          options.issues.some((issue) => issue.id === where.id)
            ? { teamId: TEAM }
            : null,
        ),
      ),
      findMany: jest.fn(({ where, select }) => {
        // Existence check for the vanished-record pass.
        if (where.id?.in) {
          return Promise.resolve(
            options.issues
              .filter((issue) => where.id.in.includes(issue.id))
              .map((issue) => ({ id: issue.id })),
          );
        }

        // The changed-since pass. `deleted` is only selectable on models that
        // carry it, which the service probes for by trying.
        const changed = options.issues.filter(
          (issue) => issue.updatedAt > where.updatedAt.gt,
        );

        return Promise.resolve(
          select.deleted
            ? changed.map(({ id, deleted }) => ({ id, deleted }))
            : changed.map(({ id }) => ({ id })),
        );
      }),
    },
  } as unknown as PrismaService;

  return { service: new SyncRepairService(prisma), written };
}

describe('SyncRepairService.reconcile', () => {
  it('announces a record changed while nothing was listening', async () => {
    const { service, written } = buildService({
      issues: [{ id: 'issue-1', updatedAt: AFTER, deleted: null }],
      announced: [{ modelId: 'issue-1', action: 'I' }],
    });

    const summary = await service.reconcile();

    expect(summary.changesRecovered).toBe(1);
    expect(written).toContainEqual(
      expect.objectContaining({ modelId: 'issue-1', action: 'U' }),
    );
  });

  it('announces a soft delete as a delete, not an update', async () => {
    // Recording this as an update would hand the client a record it then keeps
    // — the opposite of what the change said.
    const { service, written } = buildService({
      issues: [{ id: 'issue-1', updatedAt: AFTER, deleted: AFTER }],
      announced: [{ modelId: 'issue-1', action: 'I' }],
    });

    await service.reconcile();

    expect(written).toContainEqual(
      expect.objectContaining({ modelId: 'issue-1', action: 'D' }),
    );
  });

  it('announces a record that vanished from the table entirely', async () => {
    // The row is gone, so nothing about it can be read. The log claiming it
    // exists is the only evidence that clients still believe in it.
    const { service, written } = buildService({
      issues: [],
      announced: [{ modelId: 'issue-gone', action: 'I' }],
    });

    const summary = await service.reconcile();

    expect(summary.deletesRecovered).toBe(1);
    expect(written).toContainEqual(
      expect.objectContaining({ modelId: 'issue-gone', action: 'D' }),
    );
  });

  it('leaves a record alone when nothing has changed since the log', async () => {
    const { service, written } = buildService({
      issues: [{ id: 'issue-1', updatedAt: CUTOFF, deleted: null }],
      announced: [{ modelId: 'issue-1', action: 'I' }],
    });

    const summary = await service.reconcile();

    expect(summary.changesRecovered).toBe(0);
    expect(written).toHaveLength(0);
  });

  it('does nothing at all on a log that has never been written', async () => {
    // A fresh database has told no client anything, so there is nothing to be
    // out of step with — and scanning every table at first boot would be a
    // long way to discover that.
    const { service, written } = buildService({
      issues: [{ id: 'issue-1', updatedAt: AFTER, deleted: null }],
      announced: [],
      emptyLog: true,
    });

    const summary = await service.reconcile();

    expect(summary).toEqual({
      changesRecovered: 0,
      deletesRecovered: 0,
      modelsSkipped: [],
    });
    expect(written).toHaveLength(0);
  });

  it('says nothing about a record no client was ever told about', async () => {
    // Created during the downtime window: nobody has it, so nothing needs
    // correcting — and the summary must not claim a repair that never
    // happened, since that number is what the boot log reports.
    const { service, written } = buildService({
      issues: [{ id: 'issue-new', updatedAt: AFTER, deleted: null }],
      announced: [],
    });

    const summary = await service.reconcile();

    expect(written).toHaveLength(0);
    expect(summary.changesRecovered).toBe(0);
  });
});

describe('nextSequence', () => {
  it('sits above everything already recorded', () => {
    const highest = BigInt(Date.now()) * 1000n + 500n;

    expect(nextSequence(highest)).toBeGreaterThan(highest);
  });

  /**
   * The clock is read twice — once inside `nextSequence` and once here — and the
   * millisecond can turn over in between. Reading it before and after and
   * bracketing the answer is what makes this a statement about the function
   * rather than about how long the two lines took.
   */
  it('uses the current instant when the log is behind the clock', () => {
    const before = BigInt(Date.now()) * 1000n;
    const sequence = nextSequence(1n);
    const after = BigInt(Date.now()) * 1000n;

    expect(sequence).toBeGreaterThanOrEqual(before);
    expect(sequence).toBeLessThanOrEqual(after);
  });

  it('handles a log that has never been written', () => {
    expect(nextSequence(null)).toBeGreaterThan(0n);
  });
});

/**
 * A repair must not be the way past the team boundary.
 *
 * A team is a visibility boundary (ENG-79), and it is enforced by the team on
 * each announcement. This service writes announcements of its own, so an
 * announcement written here with no team would reach the whole workspace — and
 * a period of downtime would become the way to see another team's work.
 */
describe('SyncRepairService and the team boundary', () => {
  it('carries the team of a record that is still there', async () => {
    const { service, written } = buildService({
      issues: [{ id: 'issue-1', updatedAt: AFTER, deleted: null }],
      announced: [{ modelId: 'issue-1', action: 'I' }],
    });

    await service.reconcile();

    expect(written).toContainEqual(
      expect.objectContaining({ modelId: 'issue-1', teamId: TEAM }),
    );
  });

  it('recovers the team of a record that vanished, from the log', async () => {
    const { service, written } = buildService({
      issues: [],
      announced: [{ modelId: 'issue-gone', action: 'I' }],
    });

    await service.reconcile();

    // The row is gone, so nothing can be read off it. The announcement that
    // named it while it existed is the last thing that knows its team.
    expect(written).toContainEqual(
      expect.objectContaining({
        modelId: 'issue-gone',
        action: 'D',
        teamId: TEAM,
      }),
    );
  });
});
