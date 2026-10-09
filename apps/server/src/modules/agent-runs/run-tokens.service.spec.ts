import { createHash } from 'crypto';

import type { PrismaService } from 'nestjs-prisma';

import type { UsersService } from 'modules/users/users.service';

import { RunTokensService, RUN_TOKEN_TYPE } from './run-tokens.service';

/**
 * The credential of a local run: for the person's own personal agent, short
 * lived, and tied to the run so it can be ended with it.
 */

const personal = (userId: string, ownerUserId: string, over = {}) => ({
  userId,
  settings: { agent: { ownership: 'personal', ownerUserId, ...over } },
});

function build(memberships: unknown[] = []) {
  const prisma = {
    usersOnWorkspaces: {
      findMany: jest.fn().mockResolvedValue(memberships),
      findFirst: jest
        .fn()
        .mockResolvedValue({ settings: { agent: { ownership: 'personal' } } }),
      update: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ fullname: 'Ada Lovelace', username: 'ada' }),
    },
    personalAccessToken: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const users = {
    createAgentAccount: jest.fn().mockResolvedValue({ id: 'agent-new' }),
  };

  return {
    prisma,
    users,
    service: new RunTokensService(
      prisma as unknown as PrismaService,
      users as unknown as UsersService,
    ),
  };
}

describe('RunTokensService.personalAgentFor', () => {
  it('finds the personal agent the person already owns', async () => {
    const { service, users } = build([
      personal('agent-theirs', 'user-2'),
      personal('agent-mine', 'user-1'),
    ]);

    await expect(service.personalAgentFor('ws-1', 'user-1')).resolves.toBe(
      'agent-mine',
    );
    expect(users.createAgentAccount).not.toHaveBeenCalled();
  });

  it('reuses an agent the person only hid from the list', async () => {
    const { service, users } = build([
      personal('agent-hidden', 'user-1', { hiddenAt: '2026-01-01' }),
    ]);

    await expect(service.personalAgentFor('ws-1', 'user-1')).resolves.toBe(
      'agent-hidden',
    );
    expect(users.createAgentAccount).not.toHaveBeenCalled();
  });

  it('takes the per-person lock before looking, inside one transaction', async () => {
    const { service, prisma } = build([]);

    await service.personalAgentFor('ws-1', 'user-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.usersOnWorkspaces.findMany.mock.invocationCallOrder[0],
    );
  });

  it('marks a new agent as a connector agent', async () => {
    const { service, prisma } = build([]);

    await service.personalAgentFor('ws-1', 'user-1');

    expect(prisma.usersOnWorkspaces.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          settings: {
            agent: { ownership: 'personal', connector: true },
          },
        },
      }),
    );
  });

  it('skips a disabled or single-issue identity', async () => {
    const { service, users } = build([
      personal('agent-disabled', 'user-1', { disabledAt: '2026-01-01' }),
      personal('agent-run', 'user-1', { ephemeral: true }),
    ]);

    await expect(service.personalAgentFor('ws-1', 'user-1')).resolves.toBe(
      'agent-new',
    );
    expect(users.createAgentAccount).toHaveBeenCalledWith(
      'ws-1',
      'Ada Lovelace · omp',
      'user-1',
      'personal',
    );
  });

  it('ends the standing token that creating the agent minted', async () => {
    const { service, prisma } = build([]);

    await service.personalAgentFor('ws-1', 'user-1');

    expect(prisma.personalAccessToken.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        userId: 'agent-new',
        type: 'agent',
        deleted: null,
      },
      data: { deleted: expect.any(Date) },
    });
  });
});

describe('RunTokensService.mint', () => {
  it('stores only the hash, tied to the run, expiring after its deadline', async () => {
    const { service, prisma } = build();
    const deadlineAt = new Date(Date.now() + 60 * 60 * 1000);

    const token = await service.mint({
      runId: 'run-1',
      workspaceId: 'ws-1',
      agentUserId: 'agent-1',
      deadlineAt,
    });

    expect(token.value).toMatch(/^tg_pat_/);
    expect(token.expiresAt.getTime()).toBeGreaterThan(deadlineAt.getTime());

    const data = prisma.personalAccessToken.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 'agent-1',
      workspaceId: 'ws-1',
      type: RUN_TOKEN_TYPE,
      agentRunId: 'run-1',
      expiresAt: token.expiresAt,
      tokenHash: createHash('sha256').update(token.value).digest('hex'),
    });
    expect(JSON.stringify(data)).not.toContain(token.value);
  });

  it('mints a different token each time', async () => {
    const { service } = build();
    const input = {
      runId: 'run-1',
      workspaceId: 'ws-1',
      agentUserId: 'agent-1',
      deadlineAt: new Date(),
    };

    const [a, b] = await Promise.all([
      service.mint(input),
      service.mint(input),
    ]);

    expect(a.value).not.toBe(b.value);
  });
});

describe('RunTokensService.revoke', () => {
  it('ends every live token of the run', async () => {
    const { service, prisma } = build();

    await service.revoke('run-1');

    expect(prisma.personalAccessToken.updateMany).toHaveBeenCalledWith({
      where: { agentRunId: 'run-1', deleted: null },
      data: { deleted: expect.any(Date) },
    });
  });

  it('does not throw when the database does', async () => {
    const { service, prisma } = build();
    prisma.personalAccessToken.updateMany.mockRejectedValue(new Error('down'));

    await expect(service.revoke('run-1')).resolves.toBeUndefined();
  });
});
