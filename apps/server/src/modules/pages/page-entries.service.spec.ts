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
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  KnowledgeTrustEnum,
  PageEntryCitationCheckEnum,
  PageEntryCitationKindEnum,
  PageEntryKindEnum,
  PageEntryPolicyEnum,
  PageEntryStatusEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import type { VectorService } from 'modules/vector/vector.service';

import type EntryCitationsService from './entry-citations.service';
import type KnowledgeIndexService from './knowledge-index.service';
import PageEntriesService, { contentHashOf } from './page-entries.service';
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
  supersededBy?: { id: string; status?: PageEntryStatusEnum } | null;
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
    moduleRepo: { findMany: jest.fn(() => Promise.resolve([])) },
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
          page: { workspaceId: 'workspace-1' },
        }),
      ),
      // Returns what postgres would: the row, and its citations as rows when
      // they are asked for.
      create: jest.fn(({ data, include }) => {
        created.push(data);
        const { citations, ...row } = data;
        return {
          id: 'entry-new',
          ...row,
          ...(include?.citations && {
            citations: (citations?.create ?? []).map((citation: object) => ({
              targetLabel: null as string | null,
              judgment: null as string | null,
              judgeModel: null as string | null,
              moduleRepo: { fullName: 'acme/api' },
              ...citation,
            })),
          }),
        };
      }),
      update: jest.fn(({ where, data, include }) => ({
        id: where.id,
        ...data,
        ...(include?.citations && { citations: [] }),
      })),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    pageEntryUse: {
      createMany: jest.fn(({ data }) =>
        Promise.resolve({ count: data.length }),
      ),
    },
    // The transaction double runs whatever the service handed it, so a create
    // that was never reached stays absent from `created`.
    $transaction: jest.fn((operations: unknown[]) =>
      Promise.resolve(operations),
    ),
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
      entryStatus: PageEntryStatusEnum.SUPERSEDED,
      supersededBy: { id: 'entry-newer', status: PageEntryStatusEnum.STANDING },
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
  const RECALL = { workspaceId: 'workspace-1', via: 'RECALL' as const };

  it('increments retrieval counts atomically', async () => {
    const { service, prisma } = buildService();

    await service.recordServed(['entry-1', 'entry-2'], RECALL);

    const { data } = (prisma.pageEntry.updateMany as jest.Mock).mock
      .calls[0][0];
    // A read-then-write would lose one of two concurrent searches, and this
    // number decides what survives the decay pass.
    expect(data.retrievalCount).toEqual({ increment: 1 });
    expect(data.lastServedAt).toBeInstanceOf(Date);
  });

  it('[KG-3.1] writes a use row for each entry served, with who it went to and how', async () => {
    const { service, prisma } = buildService();

    await service.recordServed(['entry-1', 'entry-2', 'entry-1'], {
      workspaceId: 'workspace-1',
      via: 'RECALL',
      sessionId: 'session-7',
      tokenId: 'token-3',
      userId: 'agent-1',
    });

    // One insert for the lot, one row per entry however often it appeared.
    expect(prisma.pageEntryUse.createMany).toHaveBeenCalledTimes(1);
    const { data } = (prisma.pageEntryUse.createMany as jest.Mock).mock
      .calls[0][0];
    expect(data).toEqual(
      ['entry-1', 'entry-2'].map((entryId) => ({
        entryId,
        workspaceId: 'workspace-1',
        via: 'RECALL',
        agentRunId: null as string | null,
        sessionId: 'session-7',
        tokenId: 'token-3',
        userId: 'agent-1',
      })),
    );

    // The counters move for the same entries, once each.
    const counted = (prisma.pageEntry.updateMany as jest.Mock).mock.calls[0][0];
    expect(counted.where).toEqual({ id: { in: ['entry-1', 'entry-2'] } });
  });

  it('[KG-3.1] writes the counts and the uses together, so they cannot disagree', async () => {
    const { service, prisma } = buildService();

    await service.recordServed(['entry-1'], {
      workspaceId: 'workspace-1',
      via: 'CONTEXT_PACK',
      agentRunId: 'run-1',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [writes] = (prisma.$transaction as jest.Mock).mock.calls[0];
    expect(writes).toHaveLength(2);
    expect(
      (prisma.pageEntryUse.createMany as jest.Mock).mock.calls[0][0].data[0],
    ).toMatchObject({ via: 'CONTEXT_PACK', agentRunId: 'run-1' });
  });

  it('[KG-3.1] writes nothing when nothing was served', async () => {
    const { service, prisma } = buildService();

    await service.recordServed([], RECALL);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.pageEntryUse.createMany).not.toHaveBeenCalled();
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
      // New words are a new hash, which is what repeats are found by.
      contentHash: contentHashOf('clearer words'),
      scope: 'apps/server',
      // A new scope is resolved to modules again; this workspace has none.
      moduleIds: [],
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

/**
 * Corrections, against a stateful double.
 *
 * Correcting is a sequence — write, triage, write again — and what matters is
 * the state the entries end in, which a double answering every query with
 * the same row cannot show. This one keeps rows, derives the two sides of the
 * supersede pointer from them, defers writes until the transaction runs them
 * in array order, and refuses a second row pointing at the same entry the way
 * the unique index does.
 */
describe('corrections', () => {
  interface Row {
    id: string;
    pageId: string;
    content: string;
    status: PageEntryStatusEnum;
    supersedesId: string | null;
    sourceUserId: string;
    sourceTokenId: string | null;
    deleted: null;
    scope: null;
    verifiedAt: null;
    retrievalCount: number;
  }

  const PERSON = 'human-1';
  const BOT = 'agent-1';

  interface Deferred<T> extends PromiseLike<T> {
    run: () => T;
  }

  /**
   * A write that runs when a transaction runs it, or when it is awaited on its
   * own — the way a PrismaPromise does — and only once.
   */
  function deferred<T>(write: () => T): Deferred<T> {
    let done = false;
    let result: T;
    const run = () => {
      if (!done) {
        result = write();
        done = true;
      }
      return result;
    };
    return {
      run,
      then: (onFulfilled, onRejected) =>
        new Promise<T>((resolve) => resolve(run())).then(
          onFulfilled,
          onRejected,
        ),
    };
  }

  function bank(initial: Array<Partial<Row> & { id: string }>) {
    const rows = new Map<string, Row>();
    let next = 0;

    const put = (row: Partial<Row> & { id: string }) =>
      rows.set(row.id, {
        pageId: 'page-1',
        content: `fact ${row.id}`,
        status: PageEntryStatusEnum.STANDING,
        supersedesId: null,
        sourceUserId: PERSON,
        sourceTokenId: null,
        deleted: null,
        scope: null,
        verifiedAt: null,
        retrievalCount: 0,
        ...row,
      });
    initial.forEach(put);

    const assertUniquePointer = (id: string, pointer: string | null) => {
      if (!pointer) return;
      for (const row of rows.values()) {
        if (row.id !== id && row.supersedesId === pointer) {
          throw new Error(
            `unique violation: ${row.id} already points at ${pointer}`,
          );
        }
      }
    };

    const view = (row: Row) => {
      const target = row.supersedesId ? rows.get(row.supersedesId) : null;
      const replacement = [...rows.values()].find(
        (other) => other.supersedesId === row.id,
      );
      return {
        ...row,
        page: { workspaceId: 'workspace-1' },
        supersedes: target ? { status: target.status } : null,
        supersededBy: replacement
          ? { id: replacement.id, status: replacement.status }
          : null,
      };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matches = (row: Row, where: any): boolean => {
      if (where.id !== undefined) {
        if (
          typeof where.id === 'string'
            ? row.id !== where.id
            : !where.id.in.includes(row.id)
        )
          return false;
      }
      if (where.pageId !== undefined && row.pageId !== where.pageId)
        return false;
      if (where.status !== undefined) {
        if (
          typeof where.status === 'string'
            ? row.status !== where.status
            : !where.status.in.includes(row.status)
        )
          return false;
      }
      if (
        where.sourceTokenId !== undefined &&
        row.sourceTokenId !== where.sourceTokenId
      )
        return false;
      if (
        where.sourceUserId !== undefined &&
        row.sourceUserId !== where.sourceUserId
      )
        return false;
      return true;
    };

    const prisma = {
      page: {
        findFirst: jest.fn(async () => ({
          id: 'page-1',
          title: 'Deployment',
          entryPolicy: PageEntryPolicyEnum.OPEN,
          workspaceId: 'workspace-1',
        })),
      },
      user: {
        findUnique: jest.fn(async ({ where }) => ({
          type: where.id === BOT ? 'Agent' : 'User',
        })),
      },
      moduleRepo: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
      pageEntry: {
        findFirst: jest.fn(async ({ where }) => {
          const row = rows.get(where.id);
          return row && matches(row, where) ? view(row) : null;
        }),
        findMany: jest.fn(async ({ where }) =>
          [...rows.values()].filter((row) => matches(row, where)).map(view),
        ),
        create: jest.fn(({ data }) =>
          deferred(() => {
            const id = `new-${++next}`;
            assertUniquePointer(id, data.supersedesId);
            put({ ...data, id });
            return rows.get(id);
          }),
        ),
        update: jest.fn(({ where, data }) =>
          deferred(() => {
            const row = rows.get(where.id) as Row;
            if ('supersedesId' in data)
              assertUniquePointer(row.id, data.supersedesId);
            Object.assign(row, data);
            return row;
          }),
        ),
        updateMany: jest.fn(({ where, data }) =>
          deferred(() => {
            const hit = [...rows.values()].filter((row) => matches(row, where));
            hit.forEach((row) => Object.assign(row, data));
            return { count: hit.length };
          }),
        ),
      },
      // Like Prisma, nothing runs until the transaction does, and then in the
      // order of the array, not the order the service happened to build it.
      $transaction: jest.fn(async (writes: Array<Deferred<unknown>>) =>
        writes.map((write) => write.run()),
      ),
    } as unknown as PrismaService;

    const service = new PageEntriesService(prisma);
    const status = (id: string) => rows.get(id)?.status;
    const pointer = (id: string) => rows.get(id)?.supersedesId;
    const correct = async (writer: string, target: string, standing = false) =>
      service.createEntry(
        'page-1',
        { userId: writer, tokenId: writer === BOT ? 'token-1' : null },
        {
          content: `correction of ${target} ${next}`,
          supersedesId: target,
          ...(standing ? { standing: true } : {}),
        },
      );

    return { service, status, pointer, correct };
  }

  it("[KG-0.1] keeps an entry in use while an agent's correction of it waits, and retires it on acceptance", async () => {
    const { service, status, pointer, correct } = bank([{ id: 'A' }]);

    const b = await correct(BOT, 'A');
    expect(status('A')).toBe(PageEntryStatusEnum.STANDING);
    expect(status(b.id)).toBe(PageEntryStatusEnum.PROPOSED);
    expect(pointer(b.id)).toBe('A');

    await service.updateEntry(b.id, PERSON, {
      status: PageEntryStatusEnum.STANDING,
    });
    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(status(b.id)).toBe(PageEntryStatusEnum.STANDING);
  });

  it('[KG-0.1] retires an entry at once when a person writes its correction as standing knowledge', async () => {
    const { status, correct } = bank([{ id: 'A' }]);

    await correct(PERSON, 'A', true);

    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
  });

  it('[KG-0.1] retires the original when a correction of a waiting correction is accepted', async () => {
    const { service, status, correct } = bank([{ id: 'A' }]);

    const b = await correct(BOT, 'A');
    // The refined claim would be refused as a near match of B, so the agent
    // supersedes B instead.
    const c = await correct(BOT, b.id);
    await service.updateEntry(c.id, PERSON, {
      status: PageEntryStatusEnum.STANDING,
    });

    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(status(b.id)).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(status(c.id)).toBe(PageEntryStatusEnum.STANDING);
    // A is decided, so it is not locked behind a correction "waiting" forever:
    // the next correction goes to C, which is what the refusal says.
    await expect(correct(PERSON, 'A', true)).rejects.toThrow(
      /already been superseded/,
    );
    await expect(correct(PERSON, c.id, true)).resolves.toBeDefined();
  });

  it('[KG-0.1] still retires the original when a disputed correction is later accepted', async () => {
    const { service, status, pointer, correct } = bank([{ id: 'A' }]);

    const b = await correct(BOT, 'A');
    await service.updateEntry(b.id, PERSON, {
      status: PageEntryStatusEnum.DISPUTED,
    });
    expect(status('A')).toBe(PageEntryStatusEnum.STANDING);
    expect(pointer(b.id)).toBe('A');

    await service.updateEntry(b.id, PERSON, {
      status: PageEntryStatusEnum.STANDING,
    });
    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
  });

  it('[KG-0.1] lets a new correction replace a rejected one, which then retires nothing if revived', async () => {
    const { service, status, pointer, correct } = bank([{ id: 'A' }]);

    const b = await correct(BOT, 'A');
    await service.updateEntry(b.id, PERSON, {
      status: PageEntryStatusEnum.ARCHIVED,
    });

    const d = await correct(BOT, 'A');
    expect(pointer(d.id)).toBe('A');
    expect(pointer(b.id)).toBeNull();

    await service.updateEntry(b.id, PERSON, {
      status: PageEntryStatusEnum.STANDING,
    });
    expect(status('A')).toBe(PageEntryStatusEnum.STANDING);

    await service.updateEntry(d.id, PERSON, {
      status: PageEntryStatusEnum.STANDING,
    });
    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
  });

  it("[KG-0.1] refuses an agent's second correction while one waits, but lets a person's standing one displace it", async () => {
    const { status, pointer, correct } = bank([{ id: 'A' }]);

    const b = await correct(BOT, 'A');
    await expect(correct(BOT, 'A')).rejects.toThrow(
      new RegExp(`already waiting for review: ${b.id}`),
    );

    const f = await correct(PERSON, 'A', true);
    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(pointer(f.id)).toBe('A');
    // The displaced claim stays in the inbox as an ordinary claim.
    expect(status(b.id)).toBe(PageEntryStatusEnum.PROPOSED);
    expect(pointer(b.id)).toBeNull();
  });

  it('[KG-0.1] retires what accepted corrections replace when a person triages in bulk', async () => {
    const { service, status, correct } = bank([{ id: 'A' }, { id: 'X' }]);

    const b = await correct(BOT, 'A');
    const plain = await service.createEntry(
      'page-1',
      { userId: BOT, tokenId: 'token-1' },
      { content: 'an unrelated fact' },
    );

    await service.bulkUpdate('workspace-1', PERSON, {
      entryIds: [b.id, plain.id],
      status: PageEntryStatusEnum.STANDING,
    });

    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(status('X')).toBe(PageEntryStatusEnum.STANDING);
    expect(status(b.id)).toBe(PageEntryStatusEnum.STANDING);
    expect(status(plain.id)).toBe(PageEntryStatusEnum.STANDING);
  });

  it("[KG-0.1] keeps a disputed correction's claim: an agent cannot take it over, a person's standing correction can", async () => {
    const { service, status, pointer, correct } = bank([{ id: 'A' }]);

    const b = await correct(BOT, 'A');
    await service.updateEntry(b.id, PERSON, {
      status: PageEntryStatusEnum.DISPUTED,
    });

    await expect(correct(BOT, 'A')).rejects.toThrow(
      new RegExp(`already waiting for review: ${b.id}`),
    );
    expect(pointer(b.id)).toBe('A');

    await correct(PERSON, 'A', true);
    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(pointer(b.id)).toBeNull();
  });

  it('[KG-0.1] does not undo an archived correction by accepting a correction of it', async () => {
    const { service, status, correct } = bank([{ id: 'A' }]);

    const b = await correct(BOT, 'A');
    await service.updateEntry(b.id, PERSON, {
      status: PageEntryStatusEnum.ARCHIVED,
    });
    const c = await correct(BOT, b.id);
    await service.updateEntry(c.id, PERSON, {
      status: PageEntryStatusEnum.STANDING,
    });

    // C replaces B, which a person had rejected as a replacement for A.
    expect(status(b.id)).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(status('A')).toBe(PageEntryStatusEnum.STANDING);
  });

  it('[KG-0.1] retires a disputed target accepted in the same batch as its correction', async () => {
    const { service, status, correct } = bank([{ id: 'A' }]);

    const b = await correct(BOT, 'A');
    await service.updateEntry('A', PERSON, {
      status: PageEntryStatusEnum.DISPUTED,
    });

    // The status write has to land before the retirement, or A comes back.
    await service.bulkUpdate('workspace-1', PERSON, {
      entryIds: ['A', b.id],
      status: PageEntryStatusEnum.STANDING,
    });

    expect(status('A')).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(status(b.id)).toBe(PageEntryStatusEnum.STANDING);
  });

  it('[KG-0.1] sends a correction of text folded into the page body to the body', async () => {
    const { correct } = bank([
      { id: 'A', status: PageEntryStatusEnum.CONSOLIDATED },
    ]);

    await expect(correct(BOT, 'A')).rejects.toThrow(
      /folded into the page body/,
    );
    await expect(correct(PERSON, 'A', true)).rejects.toThrow(
      /folded into the page body/,
    );
  });

  it('[KG-0.1] never moves an entry out of a decided state', async () => {
    const { service, status } = bank([
      { id: 'A', status: PageEntryStatusEnum.CONSOLIDATED },
      {
        id: 'B',
        status: PageEntryStatusEnum.PROPOSED,
        supersedesId: 'A',
        sourceUserId: BOT,
      },
    ]);

    await service.updateEntry('B', PERSON, {
      status: PageEntryStatusEnum.STANDING,
    });

    expect(status('A')).toBe(PageEntryStatusEnum.CONSOLIDATED);
  });
});

describe("an entry's modules", () => {
  const repos = [
    {
      moduleId: 'server',
      pathPrefixes: ['apps/server/'],
      fullName: 'acme/app',
    },
    {
      moduleId: 'webapp',
      pathPrefixes: ['apps/webapp/'],
      fullName: 'acme/app',
    },
  ];

  function withRepos() {
    const built = buildService({ userType: 'User' });
    (
      built.prisma.moduleRepo.findMany as unknown as jest.Mock
    ).mockResolvedValue(repos);
    return built;
  }

  it('[KG-1.2] resolves the scope to modules when the entry is written', async () => {
    const { service, created, prisma } = withRepos();

    await service.createEntry('page-1', HUMAN, {
      content: 'Migrations are hand-written SQL.',
      scope: 'apps/server/prisma',
    });

    expect(created[0]).toMatchObject({ moduleIds: ['server'] });
    // Against this workspace's live repositories only.
    const { where } = (prisma.moduleRepo.findMany as unknown as jest.Mock).mock
      .calls[0][0];
    expect(where).toEqual({
      deleted: null,
      module: { workspaceId: 'workspace-1', deleted: null },
    });
  });

  it('[KG-1.2] resolves an unscoped entry to no modules without a lookup', async () => {
    const { service, created, prisma } = withRepos();

    await service.createEntry('page-1', HUMAN, { content: 'A general fact.' });

    expect(created[0]).toMatchObject({ moduleIds: [] });
    expect(prisma.moduleRepo.findMany).not.toHaveBeenCalled();
  });

  it('[KG-1.2] resolves the modules again when the scope changes, and not otherwise', async () => {
    const { service, prisma } = withRepos();

    await service.updateEntry('entry-1', 'human-1', { scope: 'apps' });
    await service.updateEntry('entry-1', 'human-1', { content: 'reworded' });

    const calls = (prisma.pageEntry.update as jest.Mock).mock.calls;
    expect(calls[0][0].data.moduleIds).toEqual(['server', 'webapp']);
    expect(calls[1][0].data).not.toHaveProperty('moduleIds');
  });

  it("[KG-1.2] rewrites only the entries whose modules moved when a workspace's repositories change", async () => {
    const update = jest.fn(
      async (_args: { where: { id: string }; data: unknown }) => ({}),
    );
    const indexer = {
      entriesChanged: jest.fn(async (_ids: string[]): Promise<void> => {}),
    };
    const prisma = {
      moduleRepo: { findMany: jest.fn(async () => repos) },
      pageEntry: {
        findMany: jest.fn(async () => [
          { id: 'still-right', scope: 'apps/server', moduleIds: ['server'] },
          { id: 'moved', scope: 'apps/webapp/src', moduleIds: ['server'] },
          { id: 'new-module', scope: 'apps/server/x', moduleIds: [] },
          { id: 'gone', scope: 'packages/ui', moduleIds: ['ui'] },
        ]),
        update,
      },
    } as unknown as PrismaService;
    const service = new PageEntriesService(
      prisma,
      indexer as unknown as KnowledgeIndexService,
    );

    await expect(service.recomputeModules('workspace-1')).resolves.toEqual({
      changed: 3,
    });

    expect(
      update.mock.calls.map(([args]) => [args.where.id, args.data]),
    ).toEqual([
      ['moved', { moduleIds: ['webapp'] }],
      ['new-module', { moduleIds: ['server'] }],
      ['gone', { moduleIds: [] }],
    ]);
    // The index learns the new modules, for exactly the entries that moved.
    expect(indexer.entriesChanged).toHaveBeenCalledWith([
      'moved',
      'new-module',
      'gone',
    ]);
  });
});

describe("an entry's kind", () => {
  it('[KG-1.4] records the kind an entry is written with, and leaves the default to the column', async () => {
    const { service, created } = buildService({ userType: 'User' });

    await service.createEntry('page-1', HUMAN, {
      content: 'We chose postgres over redis for durable state.',
      kind: PageEntryKindEnum.DECISION,
    });
    await service.createEntry('page-1', HUMAN, {
      content: 'Redis runs with no persistence.',
    });

    expect(created[0]).toMatchObject({ kind: 'DECISION' });
    // FACT is the column's default; nothing is written for it.
    expect(created[1]).not.toHaveProperty('kind');
  });

  it('[KG-1.4] lets an agent correct the kind of its own untriaged entry', async () => {
    const { service, prisma } = buildService({ userType: 'Agent' });

    await service.updateEntry('entry-1', 'agent-1', {
      kind: PageEntryKindEnum.GOTCHA,
    });

    const { data } = (prisma.pageEntry.update as jest.Mock).mock.calls[0][0];
    expect(data).toEqual({ kind: 'GOTCHA' });
  });
});

describe('entries about modules', () => {
  it('[KG-1.6] lists the entries resolved to any of the modules asked for, in the workspace', async () => {
    const { service, prisma } = buildService();

    await service.getEntries('workspace-1', {
      status: [PageEntryStatusEnum.STANDING],
      moduleIds: ['server', 'webapp'],
    });

    const { where } = (prisma.pageEntry.findMany as jest.Mock).mock.calls[0][0];
    expect(where).toMatchObject({
      page: { workspaceId: 'workspace-1', deleted: null },
      status: { in: [PageEntryStatusEnum.STANDING] },
      moduleIds: { hasSome: ['server', 'webapp'] },
    });
  });

  it('[KG-1.6] returns at most the number asked for, newest first', async () => {
    const { service, prisma } = buildService();

    await service.getEntries('workspace-1', {
      moduleIds: ['server'],
      limit: 50,
    });

    expect(
      (prisma.pageEntry.findMany as jest.Mock).mock.calls[0][0],
    ).toMatchObject({ orderBy: { createdAt: 'desc' }, take: 50 });
  });
});

describe('citations on a write', () => {
  const drafts = [
    {
      kind: PageEntryCitationKindEnum.CODE,
      moduleRepoId: 'repo-1',
      path: 'src/a.ts',
      commitSha: 'abcdef1',
      startLine: 3,
      endLine: 5,
      snippet: 'a();',
      snippetHash: 'hash',
      checkedAt: new Date(),
      checkedSha: 'abcdef1',
      checkResult: PageEntryCitationCheckEnum.HOLDS,
    },
  ];

  function withCitations(
    options: Options = {},
    checkForWrite: jest.Mock = jest.fn(async () => drafts),
  ) {
    const built = buildService(options);
    const citations = {
      checkForWrite,
      retryLater: jest.fn(async (): Promise<void> => undefined),
    };
    const service = new PageEntriesService(
      built.prisma,
      undefined,
      built.vectorService,
      citations as unknown as EntryCitationsService,
    );

    return { ...built, service, citations };
  }

  it('[KG-2.1] [KG-2.2] stores the checked citations with the entry, in the same write', async () => {
    const { service, created, citations } = withCitations();
    const cited = [{ path: 'src/a.ts', lines: '3-5', sha: 'abcdef1' }];

    await service.createEntry('page-1', AGENT, {
      content: 'The importer drops the last row when the file has no newline.',
      citations: cited,
    });

    expect(citations.checkForWrite).toHaveBeenCalledWith('workspace-1', cited);
    expect(created).toEqual([
      expect.objectContaining({ citations: { create: drafts } }),
    ]);
    // A citation the repository did not answer for is read again later.
    expect(citations.retryLater).toHaveBeenCalledWith('entry-new', drafts);
  });

  it('[KG-2.2] writes nothing when a citation does not hold', async () => {
    const refusal = new UnprocessableEntityException({
      status: 'citation-failed',
      citation: 1,
      message: 'Nothing was written: citation 1 …',
    });
    const { service, created, prisma, citations } = withCitations(
      {},
      jest.fn(async () => {
        throw refusal;
      }),
    );

    await expect(
      service.createEntry('page-1', AGENT, {
        content:
          'The importer drops the last row when the file has no newline.',
        citations: [{ path: 'src/a.ts', lines: '99', sha: 'abcdef1' }],
      }),
    ).rejects.toBe(refusal);

    expect(created).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(citations.retryLater).not.toHaveBeenCalled();
  });

  it("[KG-2.2] reads no code for a write the page's own gates refuse, or one citing nothing", async () => {
    const locked = withCitations({ policy: PageEntryPolicyEnum.LOCKED });

    await expect(
      locked.service.createEntry('page-1', AGENT, {
        content:
          'The importer drops the last row when the file has no newline.',
        citations: [{ issue: 'ENG-1' }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(locked.citations.checkForWrite).not.toHaveBeenCalled();

    const plain = withCitations();
    await plain.service.createEntry('page-1', AGENT, {
      content: 'The importer drops the last row when the file has no newline.',
    });
    expect(plain.citations.checkForWrite).not.toHaveBeenCalled();
    expect(plain.created[0]).not.toHaveProperty('citations');
  });

  it('[KG-2.1] refuses citations rather than storing them unchecked when no checker is configured', async () => {
    const { service, created } = buildService();

    await expect(
      service.createEntry('page-1', AGENT, {
        content:
          'The importer drops the last row when the file has no newline.',
        citations: [{ issue: 'ENG-1' }],
      }),
    ).rejects.toThrow('no checker');
    expect(created).toEqual([]);
  });
});

describe('an entry as it is written', () => {
  it('[KG-2.8] comes back with its trust, citations and last check, so the writer sees what they came to', async () => {
    const checkedAt = new Date('2026-09-27T01:00:00Z');
    const { prisma, vectorService } = buildService();
    const withCitations = new PageEntriesService(
      prisma,
      undefined,
      vectorService,
      {
        checkForWrite: jest.fn(async () => [
          {
            kind: PageEntryCitationKindEnum.CODE,
            moduleRepoId: 'repo-1',
            path: 'src/a.ts',
            commitSha: 'abcdef1',
            startLine: 3,
            endLine: 5,
            snippet: 'a();',
            snippetHash: 'hash',
            checkedAt,
            checkedSha: 'abcdef1',
            checkResult: PageEntryCitationCheckEnum.HOLDS,
          },
          {
            kind: PageEntryCitationKindEnum.CODE,
            moduleRepoId: 'repo-1',
            path: 'src/b.ts',
            commitSha: 'abcdef1',
            startLine: 1,
            endLine: 1,
            checkedAt: null as Date | null,
            checkResult: PageEntryCitationCheckEnum.UNKNOWN,
          },
        ]),
        retryLater: jest.fn(async (): Promise<void> => undefined),
      } as unknown as EntryCitationsService,
    );

    const entry = await withCitations.createEntry('page-1', AGENT, {
      content: 'The importer drops the last row when the file has no newline.',
      citations: [
        { path: 'src/a.ts', lines: '3-5', sha: 'abcdef1' },
        { path: 'src/b.ts', lines: '1', sha: 'abcdef1' },
      ],
    });

    expect(entry).toMatchObject({
      id: 'entry-new',
      // Proposed: not grounded until a person accepts it.
      trust: KnowledgeTrustEnum.UNGROUNDED,
      citations: [
        {
          kind: 'CODE',
          repo: 'acme/api',
          path: 'src/a.ts',
          lines: '3-5',
          result: 'HOLDS',
          checkedSha: 'abcdef1',
        },
        { kind: 'CODE', path: 'src/b.ts', lines: '1', result: 'UNKNOWN' },
      ],
      lastCheckedAt: checkedAt.toISOString(),
      lastCheckedSha: 'abcdef1',
    });
  });

  it('[KG-2.8] comes back with its proof when it is edited', async () => {
    const { service, prisma } = buildService({ userType: 'User' });
    (prisma.pageEntry.update as jest.Mock).mockImplementationOnce(
      ({ where, data, include }) => ({
        id: where.id,
        status: PageEntryStatusEnum.STANDING,
        verifiedAt: null,
        ...data,
        ...(include?.citations && {
          citations: [
            {
              kind: 'ISSUE',
              path: null,
              commitSha: null,
              startLine: null,
              endLine: null,
              targetLabel: 'ENG-42',
              checkedAt: new Date('2026-09-27T01:00:00Z'),
              checkedSha: null,
              checkResult: 'HOLDS',
              judgment: null,
              judgeModel: null,
              moduleRepo: null,
            },
          ],
        }),
      }),
    );

    const entry = await service.updateEntry('entry-1', HUMAN.userId, {
      status: PageEntryStatusEnum.STANDING,
    });

    expect(entry).toMatchObject({
      trust: KnowledgeTrustEnum.GROUNDED,
      citations: [{ kind: 'ISSUE', target: 'ENG-42', result: 'HOLDS' }],
    });
  });
});

describe('entries as they are read', () => {
  it('[KG-2.8] carry their trust tier, citations and last check', async () => {
    const { service, prisma } = buildService();
    const checkedAt = new Date('2026-09-20T10:00:00Z');
    (prisma.pageEntry.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'entry-1',
        content: 'A fact.',
        status: PageEntryStatusEnum.STANDING,
        verifiedAt: null,
        citations: [
          {
            kind: 'CODE',
            path: 'src/a.ts',
            commitSha: 'abcdef1',
            startLine: 3,
            endLine: 5,
            targetLabel: null,
            checkedAt,
            checkedSha: 'fedcba9',
            checkResult: 'MOVED',
            judgment: null,
            judgeModel: null,
            moduleRepo: { fullName: 'acme/api' },
          },
        ],
      },
    ]);

    const [entry] = await service.getEntries('workspace-1', {
      pageId: 'page-1',
    });

    expect(entry).toMatchObject({
      id: 'entry-1',
      trust: KnowledgeTrustEnum.GROUNDED,
      citations: [
        {
          kind: 'CODE',
          repo: 'acme/api',
          path: 'src/a.ts',
          lines: '3-5',
          commitSha: 'abcdef1',
          result: 'MOVED',
          checkedAt: checkedAt.toISOString(),
          checkedSha: 'fedcba9',
        },
      ],
      lastCheckedAt: checkedAt.toISOString(),
      lastCheckedSha: 'fedcba9',
    });
    expect(
      (prisma.pageEntry.findMany as jest.Mock).mock.calls[0][0].include,
    ).toEqual({ citations: { select: expect.any(Object) } });
  });
});
