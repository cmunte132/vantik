import { KnowledgeTrustEnum, PageEntryStatusEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { KnowledgeSearchHit } from 'modules/vector/vector.interface';
import { VectorService } from 'modules/vector/vector.service';

import KnowledgeService from './knowledge.service';
import PageEntriesService from './page-entries.service';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

function entryDocument(
  overrides: Record<string, unknown> = {},
): KnowledgeSearchHit {
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
    trust: KnowledgeTrustEnum.HUMAN_VERIFIED,
    citations: [],
    lastCheckedAt: null,
    lastCheckedSha: null,
    ...overrides,
  };
}

function buildService(documents: unknown[] = [entryDocument()]) {
  const prisma = {
    pageEntry: {
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

  const vector = {
    searchKnowledge: jest.fn(async () => ({
      hits: documents,
      facets: { sourceUserId: { 'claude-opus-5': 24 } },
      found: documents.length,
    })),
  } as unknown as VectorService;
  const entries = new PageEntriesService(prisma);

  return {
    service: new KnowledgeService(prisma, vector, entries),
    vector,
    prisma,
  };
}

describe('KnowledgeService.search', () => {
  it('counts a served entry as demand for it', async () => {
    const { service, prisma } = buildService();

    await service.search(WORKSPACE, 'redis');

    const { data } = (prisma.pageEntry.updateMany as jest.Mock).mock
      .calls[0][0];
    expect(data.retrievalCount).toEqual({ increment: 1 });
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

  it('[ENG-184] gives provisional entries after the rest, and only a few', async () => {
    const provisional = (id: string) =>
      entryDocument({
        id: `entry:${id}`,
        entryId: id,
        trust: KnowledgeTrustEnum.PROVISIONAL,
        verified: false,
      });
    const { service } = buildService([
      provisional('p1'),
      provisional('p2'),
      provisional('p3'),
      entryDocument({ id: 'entry:v1', entryId: 'v1' }),
    ]);

    const pack = await service.contextPack(WORKSPACE, { query: 'deployment' });

    expect(pack.items.map((item) => item.entryId)).toEqual(['v1', 'p1', 'p2']);
    expect(pack.omitted).toBe(1);
  });

  it('[ENG-224] never records a task or a scope as a knowledge gap, though it found nothing', async () => {
    const { service, prisma } = buildService([]);

    await service.contextPack(WORKSPACE, {
      query: 'Add a retry to the webhook worker',
    });
    await service.contextPack(WORKSPACE, { scope: 'apps/server/prisma' });

    expect(prisma.pageKnowledgeGap.upsert).not.toHaveBeenCalled();
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

  it('[ENG-225] leaves out a question that an accepted fact answered', async () => {
    const { service, prisma } = buildService();

    await service.knowledgeGaps(WORKSPACE);

    const { where } = (prisma.pageKnowledgeGap.findMany as jest.Mock).mock
      .calls[0][0];
    expect(where.answeredAt).toBeNull();
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
      if (where.workspaceId && m.workspaceId !== where.workspaceId) {
        return false;
      }
      if (where.deleted === null && m.deleted) {
        return false;
      }
      if (where.id?.in && !where.id.in.includes(m.id)) {
        return false;
      }
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
      provisionalSince: null as Date | null,
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
    conventions?: Array<ReturnType<typeof row>>;
    entries?: Array<ReturnType<typeof row>>;
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
            ? (options.conventions ?? []).filter((entry) =>
                where.status.in.includes(entry.status),
              )
            : entries.filter(
                (entry) =>
                  where.id.in.includes(entry.id) &&
                  where.status.in.includes(entry.status),
              ),
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

    // Conventions are the issue's modules', served (standing, or
    // consolidated as a page's evidence), in this workspace.
    const conventionQuery = (prisma.pageEntry.findMany as jest.Mock).mock
      .calls[0][0];
    expect(conventionQuery.where).toMatchObject({
      kind: 'CONVENTION',
      status: {
        in: [PageEntryStatusEnum.STANDING, PageEntryStatusEnum.CONSOLIDATED],
      },
      deleted: null,
      moduleIds: { hasSome: [MODULE] },
      workspaceId: WORKSPACE,
      AND: [{ OR: [{ pageId: null }, { page: { deleted: null } }] }],
    });
    // The relevant ones are asked of the search by the issue's title, seeded
    // by its modules, and read back from postgres only while still accepted:
    // standing, or consolidated into a page body, which runs are not handed.
    expect(vector.searchKnowledge).toHaveBeenCalledWith(
      WORKSPACE,
      'Search omits deleted issues',
      expect.objectContaining({ boost: { modules: [MODULE], neighbours: [] } }),
    );
    expect(
      (prisma.pageEntry.findMany as jest.Mock).mock.calls[1][0].where,
    ).toMatchObject({
      status: {
        in: [PageEntryStatusEnum.STANDING, PageEntryStatusEnum.CONSOLIDATED],
      },
      deleted: null,
    });
  });

  it('[ENG-184] hands a run relevant provisional entries after the trusted ones, at most two, and pins no provisional convention', async () => {
    const provisional = (id: string, overrides: Record<string, unknown> = {}) =>
      row(id, { citations: [], provisionalSince: written, ...overrides });
    const { service, prisma } = forRun({
      entries: [
        provisional('p1'),
        provisional('p2', { kind: 'CONVENTION' }),
        provisional('p3'),
        row('grounded-1'),
      ],
      ranked: ['p1', 'p2', 'p3', 'grounded-1'],
    });

    const { packed, trace } = await service.tracedKnowledgeForRun(
      WORKSPACE,
      ask,
      LIMITS,
    );

    expect(packed.map((entry) => [entry.entryId, entry.trust])).toEqual([
      ['grounded-1', KnowledgeTrustEnum.GROUNDED],
      ['p1', KnowledgeTrustEnum.PROVISIONAL],
      ['p2', KnowledgeTrustEnum.PROVISIONAL],
    ]);
    expect(
      trace.candidates.find((candidate) => candidate.entryId === 'p3'),
    ).toMatchObject({ given: false, dropped: 'PROVISIONAL_LIMIT' });
    // A convention nobody accepted reaches a run only when it is relevant.
    expect(
      (prisma.pageEntry.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ kind: 'CONVENTION', provisionalSince: null });
  });

  it('[KG-3.2] [KG-7.4] pins a convention folded into its page’s body to its modules’ runs, as a standing one, and none retired', async () => {
    const convention = (id: string, status: PageEntryStatusEnum) =>
      row(id, { kind: 'CONVENTION', citations: [], status });
    const { service } = forRun({
      conventions: [
        convention('folded', PageEntryStatusEnum.CONSOLIDATED),
        convention('standing', PageEntryStatusEnum.STANDING),
        convention('retired', PageEntryStatusEnum.ARCHIVED),
        convention('disputed', PageEntryStatusEnum.DISPUTED),
      ],
      // Not found by the search for this run: pinned all the same.
      ranked: [],
    });

    const packed = await service.knowledgeForRun(WORKSPACE, ask, LIMITS);

    expect(packed.map((entry) => entry.entryId)).toEqual([
      'folded',
      'standing',
    ]);
  });

  it('[KG-7.4] hands a run an entry folded into a page body, which the run is not handed, and nothing retired', async () => {
    const { service } = forRun({
      entries: [
        row('folded', { status: PageEntryStatusEnum.CONSOLIDATED }),
        row('retired', { status: PageEntryStatusEnum.ARCHIVED }),
        row('replaced', { status: PageEntryStatusEnum.SUPERSEDED }),
        row('standing'),
      ],
      ranked: ['folded', 'retired', 'replaced', 'standing'],
    });

    const packed = await service.knowledgeForRun(WORKSPACE, ask, LIMITS);

    expect(packed.map((entry) => entry.entryId)).toEqual([
      'folded',
      'standing',
    ]);
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

    // Only once accepted: the conventions read asks for standing entries,
    // the ranked one for those in use, and neither for a proposed one.
    for (const t of [inModule, elsewhere]) {
      for (const [query] of (t.prisma.pageEntry.findMany as jest.Mock).mock
        .calls) {
        expect([
          PageEntryStatusEnum.STANDING,
          {
            in: [
              PageEntryStatusEnum.STANDING,
              PageEntryStatusEnum.CONSOLIDATED,
            ],
          },
        ]).toContainEqual(query.where.status);
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

  it('traces every entry a pack considered, and why each one not given was dropped', async () => {
    const long = 'y'.repeat(2_000);
    const { service } = forRun({
      conventions: [row('convention-1', { kind: 'CONVENTION' })],
      entries: [
        row('near', { moduleIds: [MODULE] }),
        row('ungrounded', { citations: [] }),
        row('big', { content: long }),
        row('fourth'),
        row('retired', { status: PageEntryStatusEnum.ARCHIVED }),
      ],
      ranked: ['near', 'ungrounded', 'retired', 'big', 'fourth'],
    });

    const { packed, trace } = await service.tracedKnowledgeForRun(
      WORKSPACE,
      ask,
      { topK: 2, tokenBudget: 200 },
    );

    expect(packed.map((entry) => entry.entryId)).toEqual([
      'convention-1',
      'near',
    ]);
    expect(trace).toMatchObject({
      query: ask.query,
      seedModuleIds: [MODULE],
      topK: 2,
      tokenBudget: 200,
      searchFailed: false,
    });
    expect(trace.tokensGiven).toBeGreaterThan(0);
    expect(trace.tokensGiven).toBeLessThanOrEqual(200);
    expect(
      trace.candidates.map(
        ({ entryId, source, searchRank, nearness, given, order, dropped }) => ({
          entryId,
          source,
          searchRank,
          nearness,
          given,
          order,
          dropped,
        }),
      ),
    ).toEqual([
      {
        entryId: 'convention-1',
        source: 'CONVENTION',
        searchRank: null,
        nearness: 'SEED',
        given: true,
        order: 1,
        dropped: null,
      },
      {
        entryId: 'near',
        source: 'SEARCH',
        searchRank: 1,
        nearness: 'SEED',
        given: true,
        order: 2,
        dropped: null,
      },
      {
        entryId: 'ungrounded',
        source: 'SEARCH',
        searchRank: 2,
        nearness: 'NONE',
        given: false,
        order: null,
        dropped: 'NOT_TRUSTED',
      },
      {
        entryId: 'retired',
        source: 'SEARCH',
        searchRank: 3,
        nearness: 'NONE',
        given: false,
        order: null,
        dropped: 'NOT_LIVE',
      },
      // Kept, as the second relevant entry, but too long for what is left.
      {
        entryId: 'big',
        source: 'SEARCH',
        searchRank: 4,
        nearness: 'NONE',
        given: false,
        order: null,
        dropped: 'BUDGET',
      },
      {
        entryId: 'fourth',
        source: 'SEARCH',
        searchRank: 5,
        nearness: 'NONE',
        given: false,
        order: null,
        dropped: 'TOP_K',
      },
    ]);
  });

  it('traces a search that failed, so a reader sees why only conventions were given', async () => {
    const { service } = forRun({
      conventions: [row('convention-1', { kind: 'CONVENTION' })],
      search: new Error('search database is down'),
    });

    const { trace } = await service.tracedKnowledgeForRun(
      WORKSPACE,
      ask,
      LIMITS,
    );

    expect(trace.searchFailed).toBe(true);
    expect(trace.candidates.map((candidate) => candidate.entryId)).toEqual([
      'convention-1',
    ]);
  });

  it('[KG-3.2] still hands over the conventions when the index cannot be searched', async () => {
    const { service } = forRun({
      conventions: [row('convention-1', { kind: 'CONVENTION' })],
      search: new Error('search database is down'),
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
