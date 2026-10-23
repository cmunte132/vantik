import { NotFoundException } from '@nestjs/common';
import { LinkAgentSessionDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { AgentSessionsService } from './agent-sessions.service';

const actor = { userId: 'agent-1', workspaceId: 'ws-1' };

/**
 * Only the rows the service reads: the issue, the caller's teams, and the
 * session table. The issue lives in team-a of workspace ws-1.
 */
function build({
  teamIds = ['team-a'],
  session = null,
  transcript = null,
  calls = [],
}: {
  teamIds?: string[];
  session?: Record<string, unknown> | null;
  transcript?: Record<string, unknown> | null;
  calls?: Array<Record<string, unknown>>;
} = {}) {
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
    team: {
      // Every team named is live in the workspace.
      findMany: jest.fn(async ({ where }) =>
        (where.id?.in ?? []).map((id: string) => ({ id })),
      ),
    },
    agentSession: {
      findFirst: jest.fn(async () => session),
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
    agentTranscript: {
      findFirst: jest.fn(async () => transcript),
    },
    agentTranscriptCall: {
      findMany: jest.fn(async () => calls),
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

describe('AgentSessionsService usage summary', () => {
  const session: Record<string, unknown> = {
    issueId: 'issue-1',
    externalId: 'omp:01a1212b-ef89-7545-abb3-1339176a6b81',
    actorUserId: 'agent-1',
    terminalCostUsd: 0.7,
    terminalTurns: 3,
    terminalUnknownCalls: 1,
    agentRun: null,
  };
  const transcript = {
    id: 'tx-1',
    knownCostUsd: 0.9,
    unattributedCostUsd: 0.2,
    unknownCallCount: 1,
    billingSummary: {
      'subscription/list': { costUsd: 0.02, pricedCalls: 1, unpricedCalls: 0 },
    },
    sources: { main: { calls: 4 }, 'child:agent-1': { calls: 2 } },
  };
  // The issue's own calls: one priced at a harness estimate, one with no amount.
  const calls = [
    {
      costUsd: 0.5,
      billingMode: 'unknown',
      costBasis: 'harness_estimate',
      data: { purpose: 'assistant' },
    },
    {
      costUsd: null,
      billingMode: 'unknown',
      costBasis: 'unknown',
      data: { purpose: 'assistant' },
    },
  ];

  it("returns the share this issue received, and the root's totals with their basis apart", async () => {
    const { service } = build({ session, transcript, calls });

    const summary = await service.usageSummary(actor, 'session-1');

    // The ledger is what the claimed calls of this issue cost, and nothing else.
    // The row's own terminal total (0.7) is not reported as a ledger amount.
    expect(summary.issue).toEqual({
      ledger: {
        costUsd: 0.5,
        turns: 2,
        unknownCalls: 1,
        byBilling: {
          'unknown/harness_estimate': {
            costUsd: 0.5,
            pricedCalls: 1,
            unpricedCalls: 0,
          },
          'unknown/unknown': { costUsd: 0, pricedCalls: 0, unpricedCalls: 1 },
        },
      },
      legacy: null,
    });
    expect(summary.canonical).toEqual({
      knownCostUsd: 0.9,
      unattributedCostUsd: 0.2,
      unknownCallCount: 1,
      byBilling: transcript.billingSummary,
      coverage: { mainCalls: 4, childSessions: 1, childCalls: 2 },
      legacyUnverified: false,
    });
  });

  it('keeps the totals recorded before the record apart, as unverified, and out of the ledger', async () => {
    const { service } = build({
      session,
      transcript: {
        ...transcript,
        sources: {
          main: {
            calls: 0,
            legacyTotals: true,
            legacyBaseline: {
              'issue-1': { costUsd: 0.4, turns: 2, unknownCalls: 0 },
            },
          },
        },
      },
      calls,
    });

    const summary = await service.usageSummary(actor, 'session-1');

    expect(summary.issue.legacy).toEqual({
      costUsd: 0.4,
      turns: 2,
      unknownCalls: 0,
      unverified: true,
    });
    expect(summary.issue.ledger.costUsd).toBe(0.5);
    expect(summary.canonical).toMatchObject({ legacyUnverified: true });
  });

  it('gives a session with no record its legacy row totals, unverified', async () => {
    const { service } = build({ session, transcript: null, calls: [] });

    await expect(
      service.usageSummary(actor, 'session-1'),
    ).resolves.toMatchObject({
      issue: {
        ledger: { costUsd: 0, turns: 0, unknownCalls: 0 },
        legacy: { costUsd: 0.7, turns: 3, unknownCalls: 1, unverified: true },
      },
      canonical: null,
    });
  });

  it("keeps the owner's session-wide and unattributed totals from a collaborator who can see the issue", async () => {
    // The collaborator is in the issue's team, so the issue's ledger is theirs.
    // Session-wide totals include the owner's private, unassigned work.
    const { service } = build({ session, transcript, calls });
    const collaborator = { userId: 'agent-2', workspaceId: 'ws-1' };

    const summary = await service.usageSummary(collaborator, 'session-1');

    expect(summary.canonical).toBeNull();
    expect(summary.issue.ledger.costUsd).toBe(0.5);
    expect(JSON.stringify(summary)).not.toContain('unattributedCostUsd');
    expect(JSON.stringify(summary)).not.toContain('knownCostUsd');
  });

  it('gives the owner the whole session, unattributed work included', async () => {
    const { service } = build({ session, transcript, calls });

    await expect(
      service.usageSummary(actor, 'session-1'),
    ).resolves.toMatchObject({
      canonical: { knownCostUsd: 0.9, unattributedCostUsd: 0.2 },
    });
  });

  it('refuses a session on an issue in a team the caller cannot see', async () => {
    const { service } = build({
      teamIds: ['team-b'],
      session,
      transcript,
      calls,
    });

    await expect(
      service.usageSummary(actor, 'session-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AgentSessionsService recording an inbox session', () => {
  const record = (
    over: { externalId?: string; harness?: string | null } = {},
  ) => ({
    issueId: 'issue-1',
    externalId: 'sess-git',
    ...over,
  });

  it('creates a session on the git inbox channel, with an unknown location', async () => {
    const { service } = build();

    const session = await service.recordInboxSession(
      actor,
      record({ harness: 'pi' }),
    );

    expect(session).toMatchObject({
      workspaceId: 'ws-1',
      issueId: 'issue-1',
      actorUserId: 'agent-1',
      externalId: 'sess-git',
      harness: 'pi',
      location: 'UNKNOWN',
      channel: 'GIT_INBOX',
    });
    expect(session.driver).toBeUndefined();
  });

  it('keeps one row for one session, and raises lastActiveAt on a repeat', async () => {
    const { service, rows } = build();

    const first = await service.recordInboxSession(actor, record());
    first.lastActiveAt = new Date('2026-01-01T00:00:00Z');
    const second = await service.recordInboxSession(actor, record());

    expect(rows.size).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.lastActiveAt.getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00Z').getTime(),
    );
  });

  it('keeps the same session id on the hooks channel apart from the inbox', async () => {
    const { service, rows } = build();

    await service.linkHookSession(actor, link({ externalId: 'sess-git' }));
    await service.recordInboxSession(actor, record());

    expect(rows.size).toBe(2);
  });

  it('refuses an issue in another workspace as if it did not exist', async () => {
    const { service, prisma } = build();

    await expect(
      service.recordInboxSession(
        { ...actor, workspaceId: 'ws-other' },
        record(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.agentSession.upsert).not.toHaveBeenCalled();
  });

  it('refuses a session id that is empty or too long', async () => {
    const { service } = build();

    await expect(
      service.recordInboxSession(actor, record({ externalId: ' ' })),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      service.recordInboxSession(
        actor,
        record({ externalId: 'x'.repeat(201) }),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
