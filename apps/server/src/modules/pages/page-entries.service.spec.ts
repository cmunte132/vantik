/**
 * The write gate on the knowledge bank.
 *
 * Everything here is a *mechanical* limit that applies to every caller — the
 * REST API, the CLI, agent-core and the MCP tools alike. The curation opinion
 * lives only in the MCP tool layer; what is tested here is arithmetic and state
 * machine, which is what has to hold when a model that ignores tool
 * descriptions is pointed at the endpoint.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PageEntryPolicyEnum, PageEntryStatusEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import type { VectorService } from 'modules/vector/vector.service';

import PageEntriesService from './page-entries.service';
import { PROPOSED_ENTRY_BUDGET, WriterIdentity } from './pages.interface';

const AGENT: WriterIdentity = { userId: 'agent-1', tokenId: 'token-1' };
const HUMAN: WriterIdentity = { userId: 'human-1', tokenId: null };

interface Options {
  policy?: PageEntryPolicyEnum;
  outstanding?: number;
  userType?: 'Agent' | 'User';
  entryStatus?: PageEntryStatusEnum;
  /** Who wrote the entry `updateEntry` finds. */
  entrySource?: string;
  /** The entry that one is a correction of, and that entry's status. */
  pointsAt?: { id: string; status: PageEntryStatusEnum } | null;
  supersededBy?: { id: string } | null;
  /** What the page already holds, for the duplicate check. */
  existing?: Array<{ id: string; content: string; status?: string }>;
  /** What the near-match search returns, or an error it throws. */
  nearMatches?: Array<{ entryId: string; content: string }> | Error;
}

function buildService({
  policy = PageEntryPolicyEnum.CURATED,
  outstanding = 0,
  userType = 'Agent',
  entryStatus = PageEntryStatusEnum.PROPOSED,
  entrySource = 'agent-1',
  pointsAt = null,
  supersededBy = null,
  existing = [],
  nearMatches = [],
}: Options = {}) {
  const created: unknown[] = [];

  const prisma = {
    page: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'page-1',
          title: 'Deployment',
          entryPolicy: policy,
          workspaceId: 'workspace-1',
        }),
      ),
    },
    user: {
      findUnique: jest.fn(() => Promise.resolve({ type: userType })),
    },
    pageEntry: {
      // The budget check asks for one token's untriaged entries; the duplicate
      // check asks for everything live on the page. The double tells them apart
      // by whether a token or source is in the filter.
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          'sourceTokenId' in where || 'sourceUserId' in where
            ? Array.from({ length: outstanding }, (_, index) => ({
                id: `existing-${index}`,
                content: `a fact ${index}`,
                status: PageEntryStatusEnum.PROPOSED,
              }))
            : existing.map((entry) => ({
                scope: null as string | null,
                status: PageEntryStatusEnum.STANDING as string,
                sourceUserId: 'someone',
                verifiedAt: null as Date | null,
                retrievalCount: 0,
                ...entry,
              })),
        ),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve({
          status: entryStatus,
          sourceUserId: entrySource,
          supersededBy,
          supersedesId: pointsAt?.id ?? null,
          supersedes: pointsAt ? { status: pointsAt.status } : null,
        }),
      ),
      create: jest.fn(({ data }) => {
        created.push(data);
        return { id: 'entry-new', ...data };
      }),
      update: jest.fn(({ where, data }) => ({ id: where.id, ...data })),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    // The transaction double runs whatever the service handed it, so a create
    // that was never reached stays absent from `created`.
    $transaction: jest.fn((operations: unknown[]) => Promise.resolve(operations)),
  } as unknown as PrismaService;

  const vectorService = {
    findSimilarEntries: jest.fn(() =>
      nearMatches instanceof Error
        ? Promise.reject(nearMatches)
        : Promise.resolve(
            nearMatches.map((hit) => ({
              id: hit.entryId,
              kind: 'entry',
              pageId: 'page-1',
              pageTitle: 'Deployment',
              title: 'Deployment',
              scope: null as string | null,
              status: PageEntryStatusEnum.STANDING,
              sourceUserId: 'someone',
              verified: false,
              retrievalCount: 0,
              ...hit,
            })),
          ),
    ),
  } as unknown as VectorService;

  return {
    service: new PageEntriesService(prisma, undefined, vectorService),
    prisma,
    created,
    vectorService,
  };
}

describe('entry policy', () => {
  it('refuses an agent append to a LOCKED page and creates nothing', async () => {
    const { service, prisma } = buildService({
      policy: PageEntryPolicyEnum.LOCKED,
    });

    await expect(
      service.createEntry('page-1', AGENT, { content: 'a fact' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });

  it('still lets a human append to a LOCKED page', async () => {
    const { service } = buildService({
      policy: PageEntryPolicyEnum.LOCKED,
      userType: 'User',
    });

    await expect(
      service.createEntry('page-1', HUMAN, { content: 'a fact' }),
    ).resolves.toBeDefined();
  });

  it('does not enforce the budget on an OPEN page', async () => {
    const { service } = buildService({
      policy: PageEntryPolicyEnum.OPEN,
      outstanding: PROPOSED_ENTRY_BUDGET + 5,
    });

    await expect(
      service.createEntry('page-1', AGENT, { content: 'a fact' }),
    ).resolves.toBeDefined();
  });
});

describe('proposed-entry budget', () => {
  it('refuses once the token is at the cap, and creates nothing', async () => {
    const { service, prisma } = buildService({
      outstanding: PROPOSED_ENTRY_BUDGET,
    });

    await expect(
      service.createEntry('page-1', AGENT, { content: 'a fact' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });

  it('names the entries in the way, so the refusal is actionable', async () => {
    const { service } = buildService({ outstanding: PROPOSED_ENTRY_BUDGET });

    // A dead end teaches an agent nothing and it retries the same append. The
    // error has to say which entries to consolidate or supersede.
    await expect(
      service.createEntry('page-1', AGENT, { content: 'a fact' }),
    ).rejects.toThrow(/existing-0/);
  });

  it('counts per token, so one harness cannot spend another’s allowance', async () => {
    const { service, prisma } = buildService({ outstanding: 0 });

    await service.createEntry('page-1', AGENT, { content: 'a fact' });

    const { where } = (prisma.pageEntry.findMany as jest.Mock).mock.calls[0][0];
    expect(where.sourceTokenId).toBe('token-1');
  });
});

describe('provenance and supersede', () => {
  it('records who asserted the fact, on which session and token', async () => {
    const { service, created } = buildService();

    await service.createEntry('page-1', AGENT, {
      content: 'Redis is only a cache here',
      scope: 'apps/server',
      sourceSession: 'session-abc',
    });

    expect(created[0]).toMatchObject({
      sourceUserId: 'agent-1',
      sourceTokenId: 'token-1',
      sourceSession: 'session-abc',
      scope: 'apps/server',
      status: PageEntryStatusEnum.PROPOSED,
    });
  });

  it('lands an agent’s write in the inbox even when it asks for STANDING', async () => {
    const { service, created } = buildService();

    await service.createEntry('page-1', AGENT, {
      content: 'a fact',
      standing: true,
    });

    // Self-approval would make the review gate optional, which is the same as
    // not having one.
    expect(created[0]).toMatchObject({
      status: PageEntryStatusEnum.PROPOSED,
    });
  });

  it('refuses to supersede an entry that already has a replacement', async () => {
    const { service, prisma } = buildService({
      supersededBy: { id: 'entry-newer' },
    });

    await expect(
      service.createEntry('page-1', AGENT, {
        content: 'a fact',
        supersedesId: 'entry-old',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });
});

describe('status transitions', () => {
  it('refuses to revive a CONSOLIDATED entry', async () => {
    const { service } = buildService({
      entryStatus: PageEntryStatusEnum.CONSOLIDATED,
      userType: 'User',
    });

    // It is already in the page body; serving it again duplicates the fact.
    await expect(
      service.updateEntry('entry-1', 'human-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to revive a SUPERSEDED entry', async () => {
    const { service } = buildService({
      entryStatus: PageEntryStatusEnum.SUPERSEDED,
      userType: 'User',
    });

    await expect(
      service.updateEntry('entry-1', 'human-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to push an entry back into the inbox', async () => {
    const { service } = buildService({
      entryStatus: PageEntryStatusEnum.STANDING,
      userType: 'User',
    });

    await expect(
      service.updateEntry('entry-1', 'human-1', {
        status: PageEntryStatusEnum.PROPOSED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a proposed entry as standing', async () => {
    const { service } = buildService({
      entryStatus: PageEntryStatusEnum.PROPOSED,
      userType: 'User',
    });

    await expect(
      service.updateEntry('entry-1', 'human-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).resolves.toBeDefined();
  });

  it('stamps who verified an entry rather than trusting the flag alone', async () => {
    const { service, prisma } = buildService({
      entryStatus: PageEntryStatusEnum.STANDING,
      userType: 'User',
    });

    await service.updateEntry('entry-1', 'human-1', { verified: true });

    const { data } = (prisma.pageEntry.update as jest.Mock).mock.calls[0][0];
    expect(data.verifiedByUserId).toBe('human-1');
    expect(data.verifiedAt).toBeInstanceOf(Date);
  });
});

describe('serving and decay', () => {
  it('increments retrieval counts atomically', async () => {
    const { service, prisma } = buildService();

    await service.recordServed(['entry-1', 'entry-2']);

    const { data } = (prisma.pageEntry.updateMany as jest.Mock).mock.calls[0][0];
    // A read-then-write would lose one of two concurrent searches, and this
    // number decides what survives the decay pass.
    expect(data.retrievalCount).toEqual({ increment: 1 });
    expect(data.lastServedAt).toBeInstanceOf(Date);
  });

  it('leaves verified standing entries alone even when nothing reads them', async () => {
    const { service, prisma } = buildService();

    await service.runDecay('workspace-1');

    const standingPass = (prisma.pageEntry.updateMany as jest.Mock).mock
      .calls[1][0];
    // Being served is a proxy for "worth keeping"; a human vouching for it
    // is the real thing, and outranks the proxy.
    expect(standingPass.where.verifiedAt).toBeNull();
  });
});

describe('what an agent may change on an entry', () => {
  it('[KG-0.1] refuses an agent promoting its own entry to STANDING, and changes nothing', async () => {
    const { service, prisma } = buildService({ userType: 'Agent' });

    await expect(
      service.updateEntry('entry-1', 'agent-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.update).not.toHaveBeenCalled();
  });

  it('[KG-0.1] refuses an agent disputing an entry', async () => {
    const { service, prisma } = buildService({
      userType: 'Agent',
      entryStatus: PageEntryStatusEnum.STANDING,
      entrySource: 'someone-else',
    });

    await expect(
      service.updateEntry('entry-1', 'agent-1', {
        status: PageEntryStatusEnum.DISPUTED,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.update).not.toHaveBeenCalled();
  });

  it('[KG-0.1] refuses an agent verifying an entry, even its own', async () => {
    const { service, prisma } = buildService({ userType: 'Agent' });

    await expect(
      service.updateEntry('entry-1', 'agent-1', { verified: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.updateEntry('entry-1', 'agent-1', { verified: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.update).not.toHaveBeenCalled();
  });

  it('[KG-0.1] refuses an agent rewriting an entry the workspace already accepted', async () => {
    // Changing the text of a standing fact is promotion by another route: the
    // new words would be served under a decision made about the old ones.
    const { service, prisma } = buildService({
      userType: 'Agent',
      entryStatus: PageEntryStatusEnum.STANDING,
    });

    await expect(
      service.updateEntry('entry-1', 'agent-1', { content: 'new words' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.update).not.toHaveBeenCalled();
  });

  it("[KG-0.1] refuses an agent editing another writer's entry", async () => {
    const { service, prisma } = buildService({
      userType: 'Agent',
      entrySource: 'someone-else',
    });

    await expect(
      service.updateEntry('entry-1', 'agent-1', { content: 'new words' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.update).not.toHaveBeenCalled();
  });

  it('[KG-0.1] still lets an agent reword or withdraw its own untriaged entry', async () => {
    const { service, prisma } = buildService({ userType: 'Agent' });

    await service.updateEntry('entry-1', 'agent-1', {
      content: 'clearer words',
      scope: 'apps/server',
    });
    await service.updateEntry('entry-1', 'agent-1', {
      status: PageEntryStatusEnum.ARCHIVED,
    });

    const calls = (prisma.pageEntry.update as jest.Mock).mock.calls;
    expect(calls[0][0].data).toEqual({
      content: 'clearer words',
      scope: 'apps/server',
    });
    expect(calls[1][0].data).toEqual({ status: PageEntryStatusEnum.ARCHIVED });
  });

  it('[KG-0.1] lets a person promote and verify the same entry', async () => {
    const { service, prisma } = buildService({ userType: 'User' });

    await service.updateEntry('entry-1', 'human-1', {
      status: PageEntryStatusEnum.STANDING,
      verified: true,
    });

    const { data } = (prisma.pageEntry.update as jest.Mock).mock.calls[0][0];
    expect(data.status).toBe(PageEntryStatusEnum.STANDING);
    expect(data.verifiedByUserId).toBe('human-1');
  });
});

describe('bulk triage', () => {
  it('[KG-0.2] refuses an agent triaging in bulk, and changes nothing', async () => {
    const { service, prisma } = buildService({ userType: 'Agent' });

    for (const status of [
      PageEntryStatusEnum.STANDING,
      PageEntryStatusEnum.DISPUTED,
      PageEntryStatusEnum.ARCHIVED,
    ]) {
      await expect(
        service.bulkUpdate('workspace-1', 'agent-1', {
          entryIds: ['entry-1', 'entry-2'],
          status,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }

    expect(prisma.pageEntry.findMany).not.toHaveBeenCalled();
    expect(prisma.pageEntry.updateMany).not.toHaveBeenCalled();
  });

  it("[KG-0.2] still applies a person's bulk decision", async () => {
    const { service, prisma } = buildService({ userType: 'User' });
    (prisma.pageEntry.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 'entry-1', status: PageEntryStatusEnum.PROPOSED },
      { id: 'entry-2', status: PageEntryStatusEnum.PROPOSED },
    ]);

    await expect(
      service.bulkUpdate('workspace-1', 'human-1', {
        entryIds: ['entry-1', 'entry-2'],
        status: PageEntryStatusEnum.STANDING,
      }),
    ).resolves.toEqual({ updated: 2, skipped: 0 });

    const { where, data } = (prisma.pageEntry.updateMany as jest.Mock).mock
      .calls[0][0];
    expect(where.id.in).toEqual(['entry-1', 'entry-2']);
    expect(data.status).toBe(PageEntryStatusEnum.STANDING);
  });
});

describe('a write the page already holds', () => {
  it('[KG-0.3] refuses an exact repeat, ignoring case and spacing, and writes nothing', async () => {
    const { service, prisma } = buildService({
      userType: 'User',
      existing: [{ id: 'entry-9', content: 'Redis holds only cache here.' }],
    });

    // A plain REST append from a person's token: no agent-core in front of it.
    const attempt = service.createEntry('page-1', HUMAN, {
      content: '  redis   holds only CACHE here. ',
    });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    const response = (
      (await attempt.catch((error) => error)) as ConflictException
    ).getResponse() as Record<string, unknown>;
    expect(response.status).toBe('needs-decision');
    expect(response.nearMatches).toEqual([
      expect.objectContaining({ entryId: 'entry-9' }),
    ]);
    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });

  it('[KG-0.3] refuses a near match found by the index, and writes nothing', async () => {
    const { service, prisma } = buildService({
      nearMatches: [
        {
          entryId: 'entry-3',
          content: 'The cache is the only thing in Redis.',
        },
      ],
    });

    const attempt = service.createEntry('page-1', AGENT, {
      content: 'Redis holds only cache here.',
    });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    const response = (
      (await attempt.catch((error) => error)) as ConflictException
    ).getResponse() as Record<string, unknown>;
    expect(response.nearMatches).toEqual([
      expect.objectContaining({ entryId: 'entry-3' }),
    ]);
    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });

  it('[KG-0.3] writes once the writer says the fact is distinct', async () => {
    const { service, prisma } = buildService({
      existing: [{ id: 'entry-9', content: 'Redis holds only cache here.' }],
      nearMatches: [{ entryId: 'entry-3', content: 'similar' }],
    });

    await expect(
      service.createEntry('page-1', AGENT, {
        content: 'Redis holds only cache here.',
        distinct: true,
      }),
    ).resolves.toBeDefined();

    expect(prisma.pageEntry.create).toHaveBeenCalledTimes(1);
  });

  it('[KG-0.3] writes a correction that supersedes the entry it repeats', async () => {
    const { service, prisma } = buildService({
      existing: [{ id: 'entry-9', content: 'Redis holds only cache here.' }],
    });

    await service.createEntry('page-1', AGENT, {
      content: 'Redis holds only cache here.',
      supersedesId: '5b1c6a52-0d5f-4d8e-9d1e-2f0f6b1a7c3e',
    });

    expect(prisma.pageEntry.create).toHaveBeenCalledTimes(1);
  });

  it('[KG-0.3] still records the fact when the index cannot be reached', async () => {
    const { service, prisma } = buildService({
      nearMatches: new Error('typesense is down'),
    });

    await expect(
      service.createEntry('page-1', AGENT, { content: 'A new fact.' }),
    ).resolves.toBeDefined();

    expect(prisma.pageEntry.create).toHaveBeenCalledTimes(1);
  });

  it('[KG-0.3] asks a person writing a standing fact about exact repeats only', async () => {
    const { service, vectorService } = buildService({
      userType: 'User',
      nearMatches: [{ entryId: 'entry-3', content: 'similar' }],
    });

    await expect(
      service.createEntry('page-1', HUMAN, {
        content: 'A new fact.',
        standing: true,
      }),
    ).resolves.toBeDefined();

    expect(vectorService.findSimilarEntries).not.toHaveBeenCalled();
  });
});

describe('decay', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

  interface Row {
    name: string;
    status: PageEntryStatusEnum;
    createdAt: Date;
    lastServedAt: Date | null;
    retrievalCount: number;
    verifiedAt: Date | null;
  }

  /**
   * Applies the fields of a Prisma `where` that the standing pass filters on,
   * so the test can say which entries it archives rather than only what the
   * query looks like.
   */
  function matches(where: Record<string, unknown>, row: Row): boolean {
    return Object.entries(where).every(([field, condition]) => {
      if (field === 'page' || field === 'deleted') {
        return true;
      }
      if (field === 'OR') {
        return (condition as Array<Record<string, unknown>>).some((branch) =>
          matches(branch, row),
        );
      }
      const value = row[field as keyof Row];
      if (condition !== null && typeof condition === 'object') {
        const { lt } = condition as { lt?: Date };
        return value instanceof Date && lt !== undefined && value < lt;
      }
      return value === condition;
    });
  }

  async function archivedBy(rows: Row[]): Promise<string[]> {
    const { service, prisma } = buildService();
    await service.runDecay('workspace-1');
    const standingPass = (prisma.pageEntry.updateMany as jest.Mock).mock
      .calls[1][0];

    return rows
      .filter((row) => matches(standingPass.where, row))
      .map((row) => row.name);
  }

  const standing = (row: Partial<Row> & { name: string }): Row => ({
    status: PageEntryStatusEnum.STANDING,
    createdAt: daysAgo(400),
    lastServedAt: null,
    retrievalCount: 0,
    verifiedAt: null,
    ...row,
  });

  it('[KG-0.6] keeps an entry served within the window, and archives one last served before it', async () => {
    await expect(
      archivedBy([
        standing({
          name: 'served yesterday',
          lastServedAt: daysAgo(1),
          retrievalCount: 7,
        }),
        standing({
          name: 'served once, long ago',
          lastServedAt: daysAgo(200),
          retrievalCount: 1,
        }),
      ]),
    ).resolves.toEqual(['served once, long ago']);
  });

  it('[KG-0.6] archives an old entry nobody ever served, and spares a verified one', async () => {
    await expect(
      archivedBy([
        standing({ name: 'never served' }),
        standing({ name: 'verified', verifiedAt: daysAgo(300) }),
        standing({ name: 'new', createdAt: daysAgo(5) }),
      ]),
    ).resolves.toEqual(['never served']);
  });
});

describe('corrections', () => {
  const TARGET = '5b1c6a52-0d5f-4d8e-9d1e-2f0f6b1a7c3e';

  function supersededIds(prisma: PrismaService): string[] {
    const calls = [
      ...(prisma.pageEntry.update as jest.Mock).mock.calls,
      ...(prisma.pageEntry.updateMany as jest.Mock).mock.calls,
    ];
    return calls
      .filter(([args]) => args.data?.status === PageEntryStatusEnum.SUPERSEDED)
      .flatMap(([args]) =>
        typeof args.where.id === 'string' ? [args.where.id] : args.where.id.in,
      );
  }

  it("[KG-0.1] keeps the corrected entry in use while an agent's correction waits for review", async () => {
    const { service, prisma, created } = buildService({
      userType: 'Agent',
      entryStatus: PageEntryStatusEnum.STANDING,
    });

    await service.createEntry('page-1', AGENT, {
      content: 'The corrected fact.',
      supersedesId: TARGET,
    });

    // The pointer is recorded so accepting the correction can retire the
    // target later, but nothing retires it now.
    expect(created[0]).toMatchObject({
      supersedesId: TARGET,
      status: PageEntryStatusEnum.PROPOSED,
    });
    expect(supersededIds(prisma)).toEqual([]);
  });

  it('[KG-0.1] retires the corrected entry at once when a person writes standing knowledge', async () => {
    const { service, prisma } = buildService({
      userType: 'User',
      entryStatus: PageEntryStatusEnum.STANDING,
    });

    await service.createEntry('page-1', HUMAN, {
      content: 'The corrected fact.',
      supersedesId: TARGET,
      standing: true,
    });

    expect(supersededIds(prisma)).toEqual([TARGET]);
  });

  it('[KG-0.1] retires the corrected entry when a person accepts the correction', async () => {
    const { service, prisma } = buildService({
      userType: 'User',
      entryStatus: PageEntryStatusEnum.PROPOSED,
      pointsAt: { id: TARGET, status: PageEntryStatusEnum.STANDING },
    });

    await service.updateEntry('correction-1', 'human-1', {
      status: PageEntryStatusEnum.STANDING,
    });

    expect(supersededIds(prisma)).toEqual([TARGET]);
  });

  it('[KG-0.1] leaves the corrected entry in use, and frees it, when the correction is rejected', async () => {
    const { service, prisma } = buildService({
      userType: 'User',
      entryStatus: PageEntryStatusEnum.PROPOSED,
      pointsAt: { id: TARGET, status: PageEntryStatusEnum.STANDING },
    });

    await service.updateEntry('correction-1', 'human-1', {
      status: PageEntryStatusEnum.ARCHIVED,
    });

    expect(supersededIds(prisma)).toEqual([]);
    const released = (prisma.pageEntry.updateMany as jest.Mock).mock.calls.find(
      ([args]) => args.data?.supersedesId === null,
    );
    expect(released?.[0].where.id.in).toEqual(['correction-1']);
  });

  it('[KG-0.1] retires the corrected entries when a person accepts corrections in bulk', async () => {
    const { service, prisma } = buildService({ userType: 'User' });
    (prisma.pageEntry.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'correction-1',
        status: PageEntryStatusEnum.PROPOSED,
        supersedesId: TARGET,
        supersedes: { status: PageEntryStatusEnum.STANDING },
      },
      {
        id: 'entry-2',
        status: PageEntryStatusEnum.PROPOSED,
        supersedesId: null,
        supersedes: null,
      },
    ]);

    await service.bulkUpdate('workspace-1', 'human-1', {
      entryIds: ['correction-1', 'entry-2'],
      status: PageEntryStatusEnum.STANDING,
    });

    expect(supersededIds(prisma)).toEqual([TARGET]);
  });

  it('[KG-0.1] refuses a second correction while the first waits for review', async () => {
    const { service, prisma } = buildService({
      userType: 'Agent',
      entryStatus: PageEntryStatusEnum.STANDING,
      supersededBy: { id: 'correction-1' },
    });

    await expect(
      service.createEntry('page-1', AGENT, {
        content: 'Another correction.',
        supersedesId: TARGET,
      }),
    ).rejects.toThrow(/already waiting for review: correction-1/);
    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });

  it('[KG-0.1] frees the corrected entry when a correction expires unreviewed', async () => {
    const { service, prisma } = buildService();

    await service.runDecay('workspace-1');

    const release = (prisma.pageEntry.updateMany as jest.Mock).mock.calls.find(
      ([args]) => args.data?.supersedesId === null,
    );
    expect(release?.[0].where).toMatchObject({
      status: PageEntryStatusEnum.ARCHIVED,
      supersedesId: { not: null },
      supersedes: { status: { not: PageEntryStatusEnum.SUPERSEDED } },
    });
  });
});
