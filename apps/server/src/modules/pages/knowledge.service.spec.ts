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
import { KnowledgeTrustEnum, PageEntryStatusEnum } from '@vantikhq/types';
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
        Promise.resolve((where.id?.in ?? []).map((id: string) => ({ id }))),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    pageEntryUse: {
      createMany: jest.fn(({ data }) =>
        Promise.resolve({ count: data.length }),
      ),
    },
    $transaction: jest.fn((writes: unknown[]) => Promise.all(writes)),
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

    const { data } = (prisma.pageEntry.updateMany as jest.Mock).mock
      .calls[0][0];
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

describe('KnowledgeService.seedsFor', () => {
  const id = (n: number) =>
    `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
  const [M1, M2, M3, M4, M5, FOREIGN, P, C1, C2, ISSUE, GONE] = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  ].map(id);

  /**
   * A small product graph: product P owns M1 and M3 and is linked from M4;
   * capability C1 spans M1 and M2, and still lists FOREIGN, which belongs to
   * another workspace, and GONE, which was deleted; capability C2 spans M5.
   * The double answers the filters the service sends.
   */
  function graph() {
    const modules: Array<{
      id: string;
      workspaceId: string;
      ownerProductId: string | null;
      linkedProductIds: string[];
      deleted?: boolean;
    }> = [
      {
        id: M1,
        workspaceId: WORKSPACE,
        ownerProductId: P,
        linkedProductIds: [],
      },
      {
        id: M2,
        workspaceId: WORKSPACE,
        ownerProductId: null,
        linkedProductIds: [],
      },
      {
        id: M3,
        workspaceId: WORKSPACE,
        ownerProductId: P,
        linkedProductIds: [],
      },
      {
        id: M4,
        workspaceId: WORKSPACE,
        ownerProductId: null,
        linkedProductIds: [P],
      },
      {
        id: M5,
        workspaceId: WORKSPACE,
        ownerProductId: null,
        linkedProductIds: [],
      },
      {
        id: FOREIGN,
        workspaceId: 'other',
        ownerProductId: P,
        linkedProductIds: [],
      },
      {
        id: GONE,
        workspaceId: WORKSPACE,
        ownerProductId: null,
        linkedProductIds: [],
        deleted: true,
      },
    ];
    const capabilities = [
      { id: C1, workspaceId: WORKSPACE, moduleIds: [M1, M2, FOREIGN, GONE] },
      { id: C2, workspaceId: WORKSPACE, moduleIds: [M5] },
    ];
    const issues = [
      { id: ISSUE, workspaceId: WORKSPACE, moduleIds: [M1], capabilityId: C2 },
    ];

    const moduleMatches = (
      m: (typeof modules)[number],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: any,
    ): boolean => {
      if (where.workspaceId && m.workspaceId !== where.workspaceId)
        return false;
      if (where.deleted === null && m.deleted) return false;
      if (where.id?.in && !where.id.in.includes(m.id)) return false;
      if (where.OR) {
        return where.OR.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (branch: any) =>
            (branch.ownerProductId &&
              branch.ownerProductId.in.includes(m.ownerProductId)) ||
            (branch.linkedProductIds &&
              m.linkedProductIds.some((p) =>
                branch.linkedProductIds.hasSome.includes(p),
              )),
        );
      }
      return true;
    };

    const prisma = {
      module: {
        findMany: jest.fn(async ({ where }) =>
          modules.filter((m) => moduleMatches(m, where)),
        ),
      },
      capability: {
        findMany: jest.fn(async ({ where }) =>
          capabilities.filter(
            (c) =>
              c.workspaceId === where.workspaceId &&
              where.OR.some(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (branch: any) =>
                  (branch.moduleIds &&
                    c.moduleIds.some((m) =>
                      branch.moduleIds.hasSome.includes(m),
                    )) ||
                  (branch.id && branch.id.in.includes(c.id)),
              ),
          ),
        ),
      },
      issue: {
        findFirst: jest.fn(
          async ({ where }) =>
            issues.find(
              (issue) =>
                issue.id === where.id &&
                issue.workspaceId === where.team.workspaceId,
            ) ?? null,
        ),
      },
    } as unknown as PrismaService;

    return new KnowledgeService(
      prisma,
      {} as VectorService,
      {} as PageEntriesService,
    );
  }

  it('[KG-1.5] expands a module one hop: its capabilities and its product', async () => {
    const seeds = await graph().seedsFor(WORKSPACE, { moduleIds: [M1] });

    expect(seeds?.modules).toEqual([M1]);
    // M2 shares capability C1; M3 is owned by M1's product; M4 is linked to
    // it. M5 is unrelated. C1 still lists FOREIGN, another workspace's, and
    // GONE, deleted; neither is a neighbour.
    expect(seeds?.neighbours.sort()).toEqual([M2, M3, M4].sort());
  });

  it("[KG-1.5] seeds from an issue's modules and its capability", async () => {
    const seeds = await graph().seedsFor(WORKSPACE, { issueId: ISSUE });

    expect(seeds?.modules).toEqual([M1]);
    // C2 is the issue's capability, so its module is a neighbour too.
    expect(seeds?.neighbours).toEqual(expect.arrayContaining([M5]));
  });

  it('[KG-1.5] ignores ids from another workspace, and seeds nothing from nothing', async () => {
    const service = graph();

    await expect(
      service.seedsFor(WORKSPACE, { moduleIds: [FOREIGN] }),
    ).resolves.toBeUndefined();
    await expect(service.seedsFor(WORKSPACE, {})).resolves.toBeUndefined();
    await expect(
      service.seedsFor('other-workspace', { issueId: ISSUE }),
    ).resolves.toBeUndefined();
  });

  it('[KG-1.4] [KG-1.5] hands kinds and seeds to the search when recalling', async () => {
    const { service, typesense, prisma } = buildService();
    Object.assign(prisma, {
      module: {
        findMany: jest.fn(async ({ where }) =>
          where.id ? [{ id: M1, ownerProductId: null as string | null }] : [],
        ),
      },
      capability: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    });

    await service.search(WORKSPACE, 'redis', {
      kinds: ['GOTCHA'],
      moduleIds: [M1],
    });

    expect(searchParams(typesense).filter_by).toContain(
      'entryKind:=[`GOTCHA`]',
    );
    expect(searchParams(typesense).sort_by).toContain(`moduleIds:=[\`${M1}\`]`);
  });

  it('[KG-1.5] hands the seeds to the search when context is loaded for an issue', async () => {
    const { service, typesense, prisma } = buildService();
    Object.assign(prisma, {
      issue: {
        findFirst: jest.fn(async () => ({
          moduleIds: [M1],
          capabilityId: null as string | null,
        })),
      },
      module: {
        findMany: jest.fn(async ({ where }) =>
          where.id ? [{ id: M1, ownerProductId: null as string | null }] : [],
        ),
      },
      capability: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    });

    await service.contextPack(WORKSPACE, { issueId: ISSUE, tokenBudget: 500 });

    expect(searchParams(typesense).sort_by).toContain(`moduleIds:=[\`${M1}\`]`);
  });
});

describe('the proof served with recall and context', () => {
  const checkedAt = new Date('2026-09-20T10:00:00Z');
  const grounded = {
    id: 'entry-1',
    status: PageEntryStatusEnum.STANDING,
    verifiedAt: null as Date | null,
    citations: [
      {
        kind: 'CODE',
        path: 'apps/server/src/cache.ts',
        commitSha: 'abcdef1',
        startLine: 12,
        endLine: 30,
        targetLabel: null as string | null,
        checkedAt,
        checkedSha: 'fedcba9',
        checkResult: 'HOLDS',
        judgment: null as string | null,
        judgeModel: null as string | null,
        moduleRepo: { fullName: 'acme/api' },
      },
    ],
  };
  const proof = {
    trust: 'GROUNDED',
    citations: [
      {
        kind: 'CODE',
        repo: 'acme/api',
        path: 'apps/server/src/cache.ts',
        lines: '12-30',
        result: 'HOLDS',
        checkedAt: checkedAt.toISOString(),
        checkedSha: 'fedcba9',
      },
    ],
    lastCheckedAt: checkedAt.toISOString(),
    lastCheckedSha: 'fedcba9',
  };

  it('[KG-2.8] gives every recalled item its trust tier, citations and last check', async () => {
    const { service, prisma } = buildService([
      entryDocument({ verified: false }),
    ]);
    (prisma.pageEntry.findMany as jest.Mock).mockResolvedValueOnce([grounded]);

    const { hits } = await service.search(WORKSPACE, 'redis');

    expect(hits[0]).toMatchObject(proof);
  });

  it('[KG-2.8] gives every item of a context pack the same, and counts it against the budget', async () => {
    const { service, prisma } = buildService([
      entryDocument({ verified: false }),
    ]);
    (prisma.pageEntry.findMany as jest.Mock).mockResolvedValueOnce([grounded]);
    const bare = await buildService([
      entryDocument({ verified: false }),
    ]).service.contextPack(WORKSPACE, { query: 'redis' });

    const pack = await service.contextPack(WORKSPACE, { query: 'redis' });

    expect(pack.items[0]).toMatchObject(proof);
    expect(pack.estimatedTokens).toBeGreaterThan(bare.estimatedTokens);
  });
});

describe('the uses recall and load_context record', () => {
  const reader = {
    userId: 'agent-1',
    tokenId: 'token-9',
    sessionId: 'session-4',
  };

  it('[KG-3.1] records each recalled entry as a use, with the session, token and reader', async () => {
    const { service, prisma } = buildService();

    await service.search(WORKSPACE, 'redis', { reader });

    const { data } = (prisma.pageEntryUse.createMany as jest.Mock).mock
      .calls[0][0];
    expect(data).toEqual([
      expect.objectContaining({
        entryId: 'entry-1',
        workspaceId: WORKSPACE,
        via: 'RECALL',
        sessionId: 'session-4',
        tokenId: 'token-9',
        userId: 'agent-1',
        agentRunId: null,
      }),
    ]);
    // And the counters the decay pass reads still move.
    expect(
      (prisma.pageEntry.updateMany as jest.Mock).mock.calls[0][0].data
        .retrievalCount,
    ).toEqual({ increment: 1 });
  });

  it('[KG-3.1] records what a context load served, as LOAD_CONTEXT', async () => {
    const { service, prisma } = buildService();

    await service.contextPack(WORKSPACE, { query: 'deployment', reader });

    const { data } = (prisma.pageEntryUse.createMany as jest.Mock).mock
      .calls[0][0];
    expect(data).toEqual([
      expect.objectContaining({
        entryId: 'entry-1',
        via: 'LOAD_CONTEXT',
        sessionId: 'session-4',
        tokenId: 'token-9',
      }),
    ]);
  });

  it('[KG-3.1] records only what fit the budget, not everything that matched', async () => {
    const long = 'x'.repeat(4_000);
    const { service, prisma } = buildService([
      entryDocument({ entryId: 'a', content: long }),
      entryDocument({ entryId: 'b', content: long }),
    ]);

    await service.contextPack(WORKSPACE, {
      query: 'deployment',
      tokenBudget: 1_200,
    });

    const { data } = (prisma.pageEntryUse.createMany as jest.Mock).mock
      .calls[0][0];
    expect(data.map((use: { entryId: string }) => use.entryId)).toEqual(['a']);
  });

  it('[KG-3.1] still answers when the uses cannot be written', async () => {
    const { service, prisma } = buildService();
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
      new Error('connection reset'),
    );

    const result = await service.search(WORKSPACE, 'redis', { reader });

    expect(result.hits).toHaveLength(1);
  });
});

describe('the knowledge a run is handed', () => {
  const MODULE = 'module-1';
  const ISSUE = 'issue-1';
  const written = new Date('2026-08-01T09:00:00Z');
  const holding = {
    kind: 'CODE',
    path: 'apps/server/src/cache.ts',
    commitSha: 'abcdef1',
    startLine: 3,
    endLine: 9,
    targetLabel: null as string | null,
    checkedAt: new Date('2026-09-20T10:00:00Z'),
    checkedSha: 'fedcba9',
    checkResult: 'HOLDS',
    judgment: null as string | null,
    judgeModel: null as string | null,
    moduleRepo: { fullName: 'acme/api' },
  };

  function row(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      content: `the fact called ${id}`,
      scope: null as string | null,
      kind: 'FACT',
      status: PageEntryStatusEnum.STANDING as string,
      verifiedAt: null as Date | null,
      createdAt: written,
      citations: [holding] as unknown[],
      ...overrides,
    };
  }

  /**
   * A workspace with conventions for the issue's module, and a search that
   * ranks the given ids in order. The double answers the two reads the
   * service makes: the module's conventions, and the ranked ids.
   */
  function forRun(options: {
    conventions?: ReturnType<typeof row>[];
    entries?: ReturnType<typeof row>[];
    ranked?: string[];
    search?: Error;
    issue?: { moduleIds: string[] } | null;
    preferences?: unknown;
  }) {
    const entries = options.entries ?? [];
    const prisma = {
      workspace: {
        findUnique: jest.fn(async () => ({
          preferences: options.preferences ?? null,
        })),
      },
      issue: {
        findFirst: jest.fn(async () =>
          options.issue === undefined ? { moduleIds: [MODULE] } : options.issue,
        ),
      },
      pageEntry: {
        findMany: jest.fn(async ({ where }) =>
          where.kind === 'CONVENTION'
            ? (options.conventions ?? [])
            : entries.filter((entry) => where.id.in.includes(entry.id)),
        ),
      },
    } as unknown as PrismaService;
    const vector = {
      searchKnowledge: jest.fn(async () => {
        if (options.search) {
          throw options.search;
        }
        return {
          hits: (options.ranked ?? []).map((entryId) => ({ entryId })),
          facets: {},
          found: 0,
        };
      }),
    };
    const service = new KnowledgeService(
      prisma,
      vector as unknown as VectorService,
      {} as PageEntriesService,
    );
    jest.spyOn(service, 'seedsFor').mockResolvedValue({
      modules: [MODULE],
      neighbours: [],
    });

    return { service, prisma, vector };
  }

  const LIMITS = { topK: 5, tokenBudget: 1_500 };
  const ask = { issueId: ISSUE, query: 'Search omits deleted issues' };

  it("[KG-3.2] hands a run its modules' conventions first, then the relevant grounded or verified entries", async () => {
    const { service, prisma, vector } = forRun({
      conventions: [row('convention-1', { kind: 'CONVENTION', citations: [] })],
      entries: [
        row('grounded-1'),
        row('ungrounded-1', { citations: [] }),
        row('verified-1', { citations: [], verifiedAt: new Date() }),
      ],
      ranked: ['ungrounded-1', 'verified-1', 'convention-1', 'grounded-1'],
    });

    const packed = await service.knowledgeForRun(WORKSPACE, ask, LIMITS);

    // The convention is packed whatever its tier; an ungrounded relevant
    // entry is not, and one already packed as a convention is not repeated.
    expect(packed.map((entry) => entry.entryId)).toEqual([
      'convention-1',
      'verified-1',
      'grounded-1',
    ]);
    expect(packed[0].trust).toBe(KnowledgeTrustEnum.UNGROUNDED);
    expect(packed.slice(1).map((entry) => entry.trust)).toEqual([
      KnowledgeTrustEnum.HUMAN_VERIFIED,
      KnowledgeTrustEnum.GROUNDED,
    ]);

    // Conventions are the issue's modules', accepted, in this workspace.
    const conventionQuery = (prisma.pageEntry.findMany as jest.Mock).mock
      .calls[0][0];
    expect(conventionQuery.where).toMatchObject({
      kind: 'CONVENTION',
      status: PageEntryStatusEnum.STANDING,
      deleted: null,
      moduleIds: { hasSome: [MODULE] },
      page: { workspaceId: WORKSPACE, deleted: null },
    });
    // The relevant ones are asked of the search by the issue's title, seeded
    // by its modules, and read back from postgres only while still accepted.
    expect(vector.searchKnowledge).toHaveBeenCalledWith(
      WORKSPACE,
      'Search omits deleted issues',
      expect.objectContaining({ boost: { modules: [MODULE], neighbours: [] } }),
    );
    expect(
      (prisma.pageEntry.findMany as jest.Mock).mock.calls[1][0].where,
    ).toMatchObject({ status: PageEntryStatusEnum.STANDING, deleted: null });
  });

  it('[KG-6.3] hands an accepted convention from review to every run in its modules, and to others a search finds it relevant to', async () => {
    const fromReview = row('from-review', {
      kind: 'CONVENTION',
      content:
        'Review found this in 3 separate agent runs on Server: use the logger, not console.log',
      citations: [
        {
          ...holding,
          kind: 'RUN',
          path: null,
          startLine: null,
          endLine: null,
          targetLabel: 'run run-a',
        },
        holding,
      ],
    });

    // A run in its module is handed it whatever the issue is about.
    const inModule = forRun({ conventions: [fromReview], ranked: [] });
    expect(
      (await inModule.service.knowledgeForRun(WORKSPACE, ask, LIMITS)).map(
        (entry) => entry.entryId,
      ),
    ).toEqual(['from-review']);

    // A run elsewhere is handed it when the search ranks it, as any
    // grounded entry is.
    const elsewhere = forRun({
      issue: { moduleIds: ['module-other'] },
      conventions: [],
      entries: [fromReview],
      ranked: ['from-review'],
    });
    const packed = await elsewhere.service.knowledgeForRun(
      WORKSPACE,
      ask,
      LIMITS,
    );
    expect(packed.map((entry) => entry.entryId)).toEqual(['from-review']);
    expect(packed[0]).toMatchObject({
      kind: 'CONVENTION',
      trust: KnowledgeTrustEnum.GROUNDED,
    });

    // Only once accepted: both reads ask for standing entries.
    for (const t of [inModule, elsewhere]) {
      for (const [query] of (t.prisma.pageEntry.findMany as jest.Mock).mock
        .calls) {
        expect(query.where.status).toBe(PageEntryStatusEnum.STANDING);
      }
    }
  });

  it('[KG-3.2] packs each entry with its citations, its age and what it is', async () => {
    const { service } = forRun({
      entries: [row('grounded-1', { scope: 'apps/server', kind: 'GOTCHA' })],
      ranked: ['grounded-1'],
    });

    const [entry] = await service.knowledgeForRun(WORKSPACE, ask, LIMITS);

    expect(entry).toMatchObject({
      entryId: 'grounded-1',
      kind: 'GOTCHA',
      scope: 'apps/server',
      body: 'the fact called grounded-1',
      writtenAt: written.toISOString(),
      trust: KnowledgeTrustEnum.GROUNDED,
      citations: [
        expect.objectContaining({
          path: 'apps/server/src/cache.ts',
          lines: '3-9',
          result: 'HOLDS',
        }),
      ],
    });
  });

  it('[KG-3.2] stops at the top K relevant entries', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { service } = forRun({
      entries: ids.map((id) => row(id)),
      ranked: ids,
    });

    const packed = await service.knowledgeForRun(WORKSPACE, ask, {
      topK: 3,
      tokenBudget: 1_500,
    });

    expect(packed.map((entry) => entry.entryId)).toEqual(['a', 'b', 'c']);
  });

  it('[KG-3.2] keeps within the token budget, leaving out what does not fit', async () => {
    const long = 'y'.repeat(2_000);
    const { service } = forRun({
      conventions: [row('convention-1', { kind: 'CONVENTION', content: long })],
      entries: [row('big', { content: long }), row('small')],
      ranked: ['big', 'small'],
    });

    // ~500 tokens each for the long ones at four characters a token.
    const packed = await service.knowledgeForRun(WORKSPACE, ask, {
      topK: 5,
      tokenBudget: 700,
    });

    expect(packed.map((entry) => entry.entryId)).toEqual([
      'convention-1',
      'small',
    ]);
  });

  it('[KG-3.2] still hands over the conventions when the index cannot be searched', async () => {
    const { service } = forRun({
      conventions: [row('convention-1', { kind: 'CONVENTION' })],
      search: new Error('typesense is down'),
    });

    const packed = await service.knowledgeForRun(WORKSPACE, ask, LIMITS);

    expect(packed.map((entry) => entry.entryId)).toEqual(['convention-1']);
  });

  it('[KG-3.2] hands over nothing for an issue that is not in the workspace', async () => {
    const { service, vector } = forRun({ issue: null });

    await expect(
      service.knowledgeForRun(WORKSPACE, ask, LIMITS),
    ).resolves.toEqual([]);
    expect(vector.searchKnowledge).not.toHaveBeenCalled();
  });

  it('[KG-3.2] takes K and the budget from the workspace’s settings when none are given', async () => {
    const entries = ['one', 'two', 'three', 'four'].map((id) => row(id));
    const { service, prisma } = forRun({
      entries,
      ranked: entries.map((entry) => entry.id),
      preferences: { knowledge: { contextTopK: 2 } },
    });

    const packed = await service.knowledgeForRun(WORKSPACE, ask);

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: WORKSPACE },
      select: { preferences: true },
    });
    expect(packed.map((entry) => entry.entryId)).toEqual(['one', 'two']);

    // Given limits are used as they are, with no read of the settings.
    const given = forRun({ entries, ranked: entries.map((entry) => entry.id) });
    await expect(
      given.service.knowledgeForRun(WORKSPACE, ask, {
        topK: 3,
        tokenBudget: 1_500,
      }),
    ).resolves.toHaveLength(3);
    expect(given.prisma.workspace.findUnique).not.toHaveBeenCalled();
  });

  it('[KG-3.1] records what was packed into a run as served to it', async () => {
    const recordServed = jest.fn(async (): Promise<void> => undefined);
    const service = new KnowledgeService(
      {} as PrismaService,
      {} as VectorService,
      { recordServed } as unknown as PageEntriesService,
    );

    await service.recordPacked(
      WORKSPACE,
      { id: 'run-1', agentUserId: 'agent-1' },
      ['entry-1', 'entry-2'],
    );

    expect(recordServed).toHaveBeenCalledWith(['entry-1', 'entry-2'], {
      workspaceId: WORKSPACE,
      via: 'CONTEXT_PACK',
      agentRunId: 'run-1',
      userId: 'agent-1',
    });

    // Bookkeeping: a failure is logged, never thrown into the delegation.
    recordServed.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      service.recordPacked(WORKSPACE, { id: 'run-1', agentUserId: 'agent-1' }, [
        'entry-1',
      ]),
    ).resolves.toBeUndefined();
  });
});
