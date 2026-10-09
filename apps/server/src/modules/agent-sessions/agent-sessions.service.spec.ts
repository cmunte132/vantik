import { NotFoundException } from '@nestjs/common';
import { LinkAgentSessionDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { AgentSessionsService } from './agent-sessions.service';

const actor = { userId: 'agent-1', workspaceId: 'ws-1' };

/**
 * Only the rows the service reads: the issue, the caller's teams, and the
 * session table. The issue lives in team-a of workspace ws-1.
 */
function build({ teamIds = ['team-a'] }: { teamIds?: string[] } = {}) {
  const issues = [{ id: 'issue-1', teamId: 'team-a', workspaceId: 'ws-1' }];
  const rows = new Map<string, Record<string, unknown>>();

  const prisma = {
    issue: {
      findFirst: jest.fn(
        async ({ where }) =>
          issues.find(
            (issue) =>
              issue.id === where.id &&
              issue.workspaceId === where.team.workspaceId,
          ) ?? null,
      ),
      findMany: jest.fn(async ({ where }) =>
        issues.filter(
          (issue) =>
            where.id.in.includes(issue.id) &&
            where.teamId.in.includes(issue.teamId),
        ),
      ),
    },
    usersOnWorkspaces: {
      findUnique: jest.fn(async () => ({ teamIds })),
    },
    agentSession: {
      upsert: jest.fn(async ({ where, create, update }) => {
        const key = JSON.stringify(
          where.workspaceId_actorUserId_channel_externalId_issueId,
        );
        const row = rows.has(key)
          ? Object.assign(rows.get(key), update)
          : { id: `session-${rows.size + 1}`, ...create };
        rows.set(key, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where }) => ({
        count: [...rows.values()].filter(
          (row) =>
            row.externalId === where.externalId &&
            row.actorUserId === where.actorUserId &&
            row.workspaceId === where.workspaceId &&
            (where.harness === null ? row.harness == null : true),
        ).length,
      })),
    },
  } as unknown as PrismaService;

  return { service: new AgentSessionsService(prisma), prisma, rows };
}

const link = (
  over: Partial<LinkAgentSessionDto> = {},
): LinkAgentSessionDto => ({
  issueId: 'issue-1',
  externalId: 'sess-abc',
  channel: 'HOOKS',
  ...over,
});

describe('AgentSessionsService linking a hooks session', () => {
  it('creates a local terminal session on the hooks channel, as the caller', async () => {
    const { service } = build();

    const session = await service.linkHookSession(
      actor,
      link({ harness: 'claude-code' }),
    );

    expect(session).toMatchObject({
      workspaceId: 'ws-1',
      issueId: 'issue-1',
      actorUserId: 'agent-1',
      externalId: 'sess-abc',
      harness: 'claude-code',
      location: 'LOCAL',
      channel: 'HOOKS',
      driver: 'TERMINAL',
    });
  });

  it('updates the same row when the session picks the issue up again', async () => {
    const { service, rows } = build();

    const first = await service.linkHookSession(actor, link());
    const second = await service.linkHookSession(
      actor,
      link({ harness: 'codex' }),
    );

    expect(rows.size).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.harness).toBe('codex');
    expect(second.endedAt).toBeNull();
  });

  it('records a harness it does not know as other', async () => {
    const { service } = build();

    const session = await service.linkHookSession(
      actor,
      link({ harness: 'Some-New-Tool' }),
    );

    expect(session.harness).toBe('other');
  });

  it('names an omp session from its id prefix, whatever harness the agent said', async () => {
    const { service } = build();

    const session = await service.linkHookSession(
      actor,
      link({
        externalId: 'omp:01a11e21-8ec7-763d-b981-ef21a2f3a662',
        harness: 'claude-code',
      }),
    );

    expect(session.harness).toBe('omp');
    expect(session.externalId).toBe('omp:01a11e21-8ec7-763d-b981-ef21a2f3a662');
  });

  it('refuses an issue in another workspace as if it did not exist', async () => {
    const { service, prisma } = build();

    await expect(
      service.linkHookSession({ ...actor, workspaceId: 'ws-other' }, link()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.agentSession.upsert).not.toHaveBeenCalled();
  });

  it('refuses an issue in a team the caller cannot see', async () => {
    const { service, prisma } = build({ teamIds: ['team-b'] });

    await expect(service.linkHookSession(actor, link())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.agentSession.upsert).not.toHaveBeenCalled();
  });

  it('refuses a session id that is empty or too long', async () => {
    const { service } = build();

    await expect(
      service.linkHookSession(actor, link({ externalId: '  ' })),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      service.linkHookSession(actor, link({ externalId: 'x'.repeat(201) })),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('AgentSessionsService touching hooks sessions', () => {
  it('marks only the caller’s rows with that session id as active', async () => {
    const { service, prisma } = build();
    await service.linkHookSession(actor, link());
    const now = new Date('2026-10-09T10:00:00Z');

    const count = await service.touchHookSession(actor, 'sess-abc', null, now);

    expect(count).toBe(1);
    expect(prisma.agentSession.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        actorUserId: 'agent-1',
        channel: 'HOOKS',
        externalId: 'sess-abc',
        deleted: null,
      },
      data: { lastActiveAt: now },
    });
  });

  it('touches nothing for a session that no issue is linked to', async () => {
    const { service } = build();

    expect(await service.touchHookSession(actor, 'unknown', 'codex')).toBe(0);
  });

  it('fills the harness of a row that has none or other', async () => {
    const { service, prisma } = build();
    await service.linkHookSession(actor, link());

    await service.touchHookSession(actor, 'sess-abc', 'cursor');

    expect(prisma.agentSession.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        OR: [{ harness: null }, { harness: 'other' }],
      }),
      data: { harness: 'cursor' },
    });
  });

  it('does not write other over a harness the hook does not know', async () => {
    const { service, prisma } = build();
    await service.linkHookSession(actor, link());
    (prisma.agentSession.updateMany as jest.Mock).mockClear();

    await service.touchHookSession(actor, 'sess-abc', 'something-new');

    expect(prisma.agentSession.updateMany).toHaveBeenCalledTimes(1);
  });
});
