import { PrismaService } from 'nestjs-prisma';

import { SessionDriversService } from './session-drivers.service';

const ID = '01a11e21-8ec7-763d-b981-ef21a2f3a662';
const peer = { workspaceId: 'ws-1', userId: 'user-1' };

type Call = [{ where: Record<string, unknown>; data: Record<string, unknown> }];

function build(rows: Array<Record<string, unknown>> = []) {
  const prisma = {
    agentSession: {
      findMany: jest.fn(async (): Promise<unknown> => rows),
      updateMany: jest.fn(async (): Promise<unknown> => ({ count: 1 })),
    },
  };

  return {
    prisma,
    service: new SessionDriversService(prisma as unknown as PrismaService),
  };
}

describe('SessionDriversService', () => {
  it('lists the omp uuid of hooks and connector sessions once, and skips a run id', async () => {
    const { service, prisma } = build([
      { externalId: `omp:${ID}`, harness: 'omp', agentRunId: null },
      { externalId: ID, harness: 'omp', agentRunId: 'run-9' },
      // A local run that has not started omp yet: its id is the run id.
      {
        externalId: '11111111-1111-4111-8111-111111111111',
        harness: 'omp',
        agentRunId: '11111111-1111-4111-8111-111111111111',
      },
    ]);

    await expect(service.watchList(peer)).resolves.toEqual([ID]);

    const calls = prisma.agentSession.findMany.mock.calls as unknown as Call[];
    expect(calls[0][0].where).toMatchObject({
      workspaceId: 'ws-1',
      location: 'LOCAL',
      harness: 'omp',
      OR: [{ actorUserId: 'user-1' }, { agentRun: { createdById: 'user-1' } }],
    });
  });

  it("updates only the person's own sessions, with a 60 second lease", async () => {
    const { service, prisma } = build();
    const now = new Date('2026-10-09T10:00:00Z');

    await expect(
      service.applyDrivers(
        peer,
        [
          { externalId: ID, driver: 'TERMINAL' },
          { externalId: ID.replace('01a1', '02b2'), driver: null },
        ],
        now,
      ),
    ).resolves.toEqual({ ok: true });

    const calls = prisma.agentSession.updateMany.mock
      .calls as unknown as Call[];
    expect(calls).toHaveLength(2);
    expect(calls[0][0].where).toMatchObject({
      workspaceId: 'ws-1',
      OR: [{ actorUserId: 'user-1' }, { agentRun: { createdById: 'user-1' } }],
      externalId: { in: [ID, `omp:${ID}`] },
    });
    expect(calls[0][0].data).toEqual({
      driver: 'TERMINAL',
      driverLeaseExpiresAt: new Date('2026-10-09T10:01:00Z'),
    });
    expect(calls[1][0].data).toEqual({
      driver: null,
      driverLeaseExpiresAt: null,
    });
  });

  it('ignores a malformed entry and refuses a body that is not a list', async () => {
    const { service, prisma } = build();

    await service.applyDrivers(peer, [
      { externalId: 'not-a-uuid', driver: 'TERMINAL' },
      { externalId: ID, driver: 'ROOT' },
      null,
    ]);

    expect(prisma.agentSession.updateMany).not.toHaveBeenCalled();
    await expect(service.applyDrivers(peer, 'x')).resolves.toMatchObject({
      ok: false,
    });
  });
});
