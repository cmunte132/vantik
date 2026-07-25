/**
 * Retrieval is the product here — agents do not browse a wiki, they ask a
 * question or load context before starting work.
 *
 * Two invariants carry most of the weight, and both are tested here rather than
 * left to review: entries the workspace has rejected, replaced or already
 * folded into a page body are never served, and the context pack fits the
 * budget it was given. The first is what keeps the bank trustworthy; the second
 * is what stops it becoming the unbounded context dump that file-based memory
 * already is.
 */
import { PageEntryStatusEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import {
  KNOWLEDGE_GROUP_LIMIT,
  KNOWLEDGE_SORT_BY,
} from 'modules/vector/vector.interface';
import { VectorService } from 'modules/vector/vector.service';

import KnowledgeService from './knowledge.service';
import PageEntriesService from './page-entries.service';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

/** A typesense double that records the parameters it was handed. */
function buildTypesense(documents: unknown[] = []) {
  return {
    multiSearch: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      perform: jest.fn((_params: any) =>
        Promise.resolve({
          results: [
            {
              grouped_hits: documents.map((document) => ({
                hits: [{ document, vector_distance: 0.3 }],
              })),
              facet_counts: [
                {
                  field_name: 'sourceUserId',
                  counts: [{ value: 'claude-opus-5', count: 24 }],
                },
              ],
              found: documents.length,
            },
          ],
        }),
      ),
    },
    collections: jest.fn(() => ({
      documents: jest.fn(() => ({ upsert: jest.fn(), delete: jest.fn() })),
    })),
  };
}

function entryDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry:entry-1',
    kind: 'entry',
    pageId: 'page-1',
    pageTitle: 'Deployment',
    entryId: 'entry-1',
    title: 'Deployment',
    content: 'Redis is a cache here and may be flushed at will',
    scope: 'apps/server',
    status: PageEntryStatusEnum.STANDING,
    sourceUserId: 'agent-1',
    verified: true,
    retrievalCount: 4,
    ...overrides,
  };
}

function buildService(documents: unknown[] = [entryDocument()]) {
  const typesense = buildTypesense(documents);

  const prisma = {
    page: {
      findMany: jest.fn(() => Promise.resolve([{ id: 'page-1' }])),
    },
    pageEntry: {
      // Echoes back whatever ids were asked about, so by default every hit is
      // live and the staleness check only bites when a test says so.
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          (where.id?.in ?? []).map((id: string) => ({ id })),
        ),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    pageKnowledgeGap: {
      upsert: jest.fn(() => Promise.resolve({})),
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            query: 'redis eviction policy',
            count: 7,
            updatedAt: new Date('2026-07-20'),
          },
        ]),
      ),
    },
  } as unknown as PrismaService;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vector = new VectorService(prisma, typesense as any);
  const entries = new PageEntriesService(prisma);

  return {
    service: new KnowledgeService(prisma, vector, entries),
    typesense,
    prisma,
  };
}

const searchParams = (typesense: ReturnType<typeof buildTypesense>) =>
  typesense.multiSearch.perform.mock.calls[0][0].searches[0];

describe('KnowledgeService.search', () => {
  it('serves standing entries only', async () => {
    const { service, typesense } = buildService();

    await service.search(WORKSPACE, 'redis');

    // The read-side half of the status guarantee. Serving a CONSOLIDATED entry
    // duplicates a fact already in the body; serving a SUPERSEDED one hands
    // back something the workspace has explicitly replaced.
    expect(searchParams(typesense).filter_by).toContain('status:=[`STANDING`]');
  });

  it('scopes to the caller’s workspace and rejects a malformed one', async () => {
    const { service, typesense } = buildService();

    await service.search(WORKSPACE, 'redis');
    expect(searchParams(typesense).filter_by).toContain(
      `workspaceId:=\`${WORKSPACE}\``,
    );

    // The same guard the issues collection carries: a filter built from an
    // unvalidated id is a filter the caller can rewrite.
    await expect(
      service.search('not-a-uuid && workspaceId:*', 'redis'),
    ).rejects.toThrow(/Invalid workspaceId/);
  });

  it('caps how much of a result set one page can occupy', async () => {
    const { service, typesense } = buildService();

    await service.search(WORKSPACE, 'redis');

    const params = searchParams(typesense);
    // The control that still holds when every other gate has failed.
    expect(params.group_by).toBe('pageId');
    expect(params.group_limit).toBe(KNOWLEDGE_GROUP_LIMIT);
  });

  it('ranks inside the query rather than re-sorting in Node', async () => {
    const { service, typesense } = buildService();

    await service.search(WORKSPACE, 'redis');

    const params = searchParams(typesense);
    expect(params.sort_by).toBe(KNOWLEDGE_SORT_BY);
    expect(params.sort_by).toContain('_eval');
  });

  it('returns facet counts sufficient to drive bulk triage', async () => {
    const { service } = buildService();

    const result = await service.search(WORKSPACE, 'redis');

    expect(result.facets.sourceUserId).toEqual({ 'claude-opus-5': 24 });
  });

  it('counts a served entry as demand for it', async () => {
    const { service, prisma } = buildService();

    await service.search(WORKSPACE, 'redis');

    const { data } = (prisma.pageEntry.updateMany as jest.Mock).mock.calls[0][0];
    expect(data.retrievalCount).toEqual({ increment: 1 });
  });

  it('drops hits whose entry has been deleted since it was indexed', async () => {
    const { service, prisma } = buildService([
      entryDocument({ id: 'entry:gone', entryId: 'gone' }),
    ]);

    // The index is a cache and postgres is the truth: a fact that survives its
    // own retraction is the failure that costs the bank its trust.
    (prisma.pageEntry.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.search(WORKSPACE, 'redis');

    expect(result.hits).toHaveLength(0);
  });

  it('records a question the bank could not answer', async () => {
    const { service, prisma } = buildService([]);

    await service.search(WORKSPACE, '  Redis   Eviction  ');

    const { where, create } = (prisma.pageKnowledgeGap.upsert as jest.Mock).mock
      .calls[0][0];
    // Normalised, so one question asked three ways is one gap with a count of
    // three rather than three gaps of one.
    expect(create.query).toBe('redis eviction');
    expect(where.workspaceId_query.workspaceId).toBe(WORKSPACE);
  });
});

describe('KnowledgeService.contextPack', () => {
  it('fits the budget it was given and says what it left out', async () => {
    const long = 'x'.repeat(4_000);
    const { service } = buildService([
      entryDocument({ entryId: 'a', content: long }),
      entryDocument({ entryId: 'b', content: long }),
      entryDocument({ entryId: 'c', content: long }),
    ]);

    // ~1000 tokens per item at four characters per token.
    const pack = await service.contextPack(WORKSPACE, {
      query: 'deployment',
      tokenBudget: 1_200,
    });

    expect(pack.estimatedTokens).toBeLessThanOrEqual(1_200);
    expect(pack.items).toHaveLength(1);
    // Honest about the truncation: a pack that silently drops two thirds of
    // what matched is worse than one that says so.
    expect(pack.omitted).toBe(2);
  });

  it('clamps an absurd budget rather than dumping the bank', async () => {
    const { service } = buildService();

    const pack = await service.contextPack(WORKSPACE, {
      query: 'deployment',
      tokenBudget: 10_000_000,
    });

    expect(pack.tokenBudget).toBeLessThanOrEqual(20_000);
  });

  it('falls back to the scope as the question when no query is given', async () => {
    const { service, typesense } = buildService();

    // An agent starting work cannot express what it does not yet know it needs,
    // but it can always say where it is working.
    await service.contextPack(WORKSPACE, { scope: 'apps/server/prisma' });

    expect(searchParams(typesense).q).toBe('apps/server/prisma');
  });
});

describe('KnowledgeService.knowledgeGaps', () => {
  it('lists the most-asked unanswered questions first', async () => {
    const { service, prisma } = buildService();

    const gaps = await service.knowledgeGaps(WORKSPACE);

    expect(gaps[0]).toMatchObject({ query: 'redis eviction policy', count: 7 });
    const { orderBy, where } = (prisma.pageKnowledgeGap.findMany as jest.Mock)
      .mock.calls[0][0];
    expect(where.workspaceId).toBe(WORKSPACE);
    expect(orderBy[0]).toEqual({ count: 'desc' });
  });
});
