import { PrismaService } from 'nestjs-prisma';

import { SessionActivityService } from './session-activity.service';

const ID = '01a1212b-ef89-7545-abb3-1339176a6b81';
const peer = { workspaceId: 'ws-1', userId: 'user-1' };

const entries = [
  {
    type: 'message',
    timestamp: '2026-10-09T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
  },
  {
    type: 'message',
    timestamp: '2026-10-09T10:00:02.000Z',
    message: {
      role: 'assistant',
      model: 'm',
      content: [
        { type: 'text', text: 'On it.' },
        {
          type: 'toolCall',
          id: 'c1',
          name: 'read',
          arguments: { path: 'a.ts' },
        },
      ],
      usage: { cost: { total: 0.5 } },
    },
  },
];

function build(sessions: Array<Record<string, unknown>>) {
  const prisma = {
    agentSession: {
      findMany: jest.fn(async (): Promise<unknown> => sessions),
      update: jest.fn(async (): Promise<unknown> => ({})),
      updateMany: jest.fn(async (): Promise<unknown> => ({ count: 1 })),
    },
    agentRunEvent: {
      createMany: jest.fn(async (): Promise<unknown> => ({ count: 3 })),
      findMany: jest.fn(async (): Promise<unknown> => []),
      deleteMany: jest.fn(),
    },
    agentSessionEvent: {
      createMany: jest.fn(async (): Promise<unknown> => ({ count: 3 })),
      findMany: jest.fn(async (): Promise<unknown> => []),
      deleteMany: jest.fn(),
    },
    agentRun: {
      findUnique: jest.fn(async (): Promise<unknown> => ({
        result: { costUsd: 1, turns: 4, branch: 'b' },
      })),
      update: jest.fn(async (): Promise<unknown> => ({})),
    },
  };

  return {
    prisma,
    service: new SessionActivityService(prisma as unknown as PrismaService),
  };
}

describe('SessionActivityService', () => {
  it('refuses a body that is not a uuid and a list', async () => {
    const { service } = build([]);

    await expect(
      service.apply(peer, { externalId: 'x', entries: [] }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      service.apply(peer, { externalId: ID, entries: 'no' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      service.apply(peer, { externalId: ID, entries: new Array(501).fill({}) }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("looks only at the person's own sessions", async () => {
    const { service, prisma } = build([]);

    await expect(
      service.apply(peer, { externalId: ID, entries }),
    ).resolves.toEqual({ ok: true });

    const call = (
      prisma.agentSession.findMany.mock.calls as unknown as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.where).toMatchObject({
      workspaceId: 'ws-1',
      externalId: { in: [ID, `omp:${ID}`] },
      OR: [{ actorUserId: 'user-1' }, { agentRun: { createdById: 'user-1' } }],
    });
    expect(prisma.agentRunEvent.createMany).not.toHaveBeenCalled();
    expect(prisma.agentSessionEvent.createMany).not.toHaveBeenCalled();
  });

  it("writes a run's session to the run's events, and adds to its totals", async () => {
    const { service, prisma } = build([
      { id: 's1', agentRunId: 'run-1', terminalSeenAt: null },
    ]);

    await service.apply(peer, { externalId: ID, entries });

    const data = (
      prisma.agentRunEvent.createMany.mock.calls as unknown as Array<
        [{ data: Array<Record<string, unknown>> }]
      >
    )[0][0].data;
    expect(data.map((row) => row.message)).toEqual([
      'Fix it',
      'On it.',
      'read: a.ts',
    ]);
    expect(data[0]).toMatchObject({
      runId: 'run-1',
      phase: 'terminal',
      data: { kind: 'note', role: 'user', source: 'terminal' },
    });
    expect(prisma.agentSessionEvent.createMany).not.toHaveBeenCalled();
    expect(prisma.agentRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { result: { costUsd: 1.5, turns: 5, branch: 'b' } },
    });
    expect(prisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: {
        terminalTurns: { increment: 1 },
        terminalCostUsd: { increment: 0.5 },
        terminalSeenAt: new Date('2026-10-09T10:00:02.000Z'),
      },
    });
  });

  it('keeps the steps of a session without a run in its own events', async () => {
    const { service, prisma } = build([
      { id: 's2', agentRunId: null, terminalSeenAt: null },
    ]);

    await service.apply(peer, { externalId: ID, entries });

    expect(prisma.agentSessionEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.agentRunEvent.createMany).not.toHaveBeenCalled();
    expect(prisma.agentRun.update).not.toHaveBeenCalled();
  });

  it('drops entries older than the newest one it holds, so a repeat adds nothing', async () => {
    const { service, prisma } = build([
      {
        id: 's2',
        agentRunId: null,
        terminalSeenAt: new Date('2026-10-09T10:00:03.000Z'),
      },
    ]);

    await service.apply(peer, { externalId: ID, entries });

    expect(prisma.agentSessionEvent.createMany).not.toHaveBeenCalled();
    expect(prisma.agentSession.update).not.toHaveBeenCalled();
  });
});
