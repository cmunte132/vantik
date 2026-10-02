import { PrismaService } from 'nestjs-prisma';

import KnowledgeOverviewService, {
  bodySummary,
  MAX_SUMMARY,
  resolveProducts,
} from './knowledge-overview.service';
import KnowledgeReviewService from './knowledge-review.service';
import LooseFactsService from './loose-facts.service';

const WORKSPACE = 'ws-1';
const NOW = new Date('2026-09-28T12:00:00Z');
const RECENT = new Date('2026-09-27T12:00:00Z');

const doc = (...nodes: unknown[]) =>
  JSON.stringify({ type: 'doc', content: nodes });
const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

describe('bodySummary', () => {
  it('[ENG-225] reads the first paragraph and skips a heading', () => {
    expect(
      bodySummary(
        doc(
          { type: 'heading', content: [{ type: 'text', text: 'Deploy' }] },
          paragraph('The server runs in   podman.'),
          paragraph('Second.'),
        ),
      ),
    ).toBe('The server runs in podman.');
  });

  it('[ENG-225] cuts a long paragraph and marks the cut', () => {
    const summary = bodySummary(doc(paragraph('word '.repeat(100))));

    expect(summary?.length).toBeLessThanOrEqual(MAX_SUMMARY);
    expect(summary?.endsWith('…')).toBe(true);
  });

  it('[ENG-225] reads a body that is not JSON as text, and an empty body as none', () => {
    expect(bodySummary('plain text')).toBe('plain text');
    expect(bodySummary(doc())).toBeNull();
    expect(bodySummary(null)).toBeNull();
  });
});

describe('resolveProducts', () => {
  const pages = [
    { id: 'root', parentId: null },
    { id: 'child', parentId: 'root' },
    { id: 'lone', parentId: null },
  ];

  it('[ENG-225] gives a page the product with the most votes, and a sub-page its parent product', () => {
    const votes = new Map([
      [
        'root',
        new Map([
          ['b', 2],
          ['a', 1],
        ]),
      ],
    ]);

    const products = resolveProducts(pages, votes);

    expect(products.get('root')).toBe('b');
    expect(products.get('child')).toBe('b');
    expect(products.has('lone')).toBe(false);
  });

  it('[ENG-225] breaks a tie the same way on every read', () => {
    const votes = new Map([
      [
        'root',
        new Map([
          ['b', 1],
          ['a', 1],
        ]),
      ],
    ]);

    expect(resolveProducts(pages, votes).get('root')).toBe('a');
  });

  it('[ENG-225] stops on a parent loop', () => {
    const loop = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];

    expect(resolveProducts(loop, new Map()).size).toBe(0);
  });
});

describe('KnowledgeOverviewService.overview', () => {
  const holds = { kind: 'CODE', checkResult: 'HOLDS', checkedAt: RECENT };
  const observed = { kind: 'URL', checkResult: 'HOLDS', checkedAt: RECENT };

  function build() {
    const prisma = {
      page: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'deploy',
            title: 'Deployment',
            parentId: null,
            kind: 'AUTHORED',
            description: doc(paragraph('How we ship.')),
            question: null,
            updatedAt: RECENT,
          },
          {
            id: 'empty',
            title: 'Empty',
            parentId: null,
            kind: 'GENERATED',
            description: null,
            question: 'What runs the cron?',
            updatedAt: RECENT,
          },
        ]),
      },
      pageEntry: {
        findMany: jest
          .fn()
          // The facts in use.
          .mockResolvedValueOnce([
            {
              id: 'e1',
              pageId: 'deploy',
              status: 'STANDING',
              verifiedAt: null,
              moduleIds: ['m1'],
              citations: [holds],
            },
            {
              id: 'e2',
              pageId: 'deploy',
              status: 'STANDING',
              verifiedAt: RECENT,
              moduleIds: [],
              citations: [],
            },
            {
              id: 'e3',
              pageId: 'deploy',
              status: 'CONSOLIDATED',
              verifiedAt: null,
              moduleIds: [],
              citations: [
                { kind: 'CODE', checkResult: 'CHANGED', checkedAt: RECENT },
              ],
            },
            {
              id: 'e4',
              pageId: 'deploy',
              status: 'STANDING',
              verifiedAt: null,
              moduleIds: [],
              citations: [observed],
            },
            // A loose fact: it counts in the workspace, and on no page.
            {
              id: 'e6',
              pageId: null,
              status: 'STANDING',
              verifiedAt: RECENT,
              moduleIds: ['m1'],
              citations: [],
            },
          ])
          // The facts written this week.
          .mockResolvedValueOnce([
            { id: 'e1', sourceUserId: 'agent' },
            { id: 'e4', sourceUserId: 'agent' },
            { id: 'e5', sourceUserId: 'person' },
          ]),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'p1', name: 'Vantik App' },
          { id: 'p2', name: 'PodReader' },
        ]),
      },
      pageEntryUse: {
        groupBy: jest.fn().mockResolvedValue([
          { entryId: 'e1', _count: { _all: 3 } },
          { entryId: 'e4', _count: { _all: 2 } },
        ]),
      },
      pageProposal: {
        findMany: jest.fn().mockResolvedValue([{ pageId: 'empty' }]),
      },
      pageLink: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { pageId: 'empty', entityType: 'PRODUCT', entityId: 'p2' },
          ]),
      },
      module: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'm1', ownerProductId: 'p1' }]),
      },
      issue: { findMany: jest.fn().mockResolvedValue([]) },
      knowledgeTriageDecision: {
        findMany: jest.fn().mockResolvedValue([
          { entryId: 'e1', entry: { citations: [{ kind: 'CODE' }] } },
          { entryId: 'e4', entry: { citations: [{ kind: 'URL' }] } },
          { entryId: 'e5', entry: { citations: [] } },
        ]),
        findFirst: jest.fn().mockResolvedValue({ createdAt: RECENT }),
      },
      pageEntryMaintenance: { findFirst: jest.fn().mockResolvedValue(null) },
      knowledgeVerification: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      pageKnowledgeGap: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest
          .fn()
          // The open gaps.
          .mockResolvedValueOnce([
            { id: 'g1', query: 'redis eviction', count: 3, updatedAt: RECENT },
            { id: 'g2', query: 'cron owner', count: 2, updatedAt: RECENT },
          ])
          // The gaps with an issue.
          .mockResolvedValueOnce([
            { id: 'g2', query: 'cron owner', issueId: 'i1' },
          ]),
      },
      agentRun: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'r1', issueId: 'i1', createdAt: RECENT, startedAt: null },
          ]),
      },
      agentRunEvent: {
        findFirst: jest.fn().mockResolvedValue({ message: 'Reading cron.ts' }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'agent' }]),
      },
    };
    const review = {
      queue: jest.fn().mockResolvedValue({
        autoTriage: 'shadow',
        items: [{ entry: { pageId: 'deploy' } }, { entry: { pageId: null } }],
        reasons: {},
        pageProposals: [],
      }),
    };
    const looseFacts = {
      loose: jest.fn().mockResolvedValue({ count: 1, groups: [] }),
    };
    const service = new KnowledgeOverviewService(
      prisma as unknown as PrismaService,
      review as unknown as KnowledgeReviewService,
      looseFacts as unknown as LooseFactsService,
    );

    return { service, prisma };
  }

  it('[ENG-225] counts the facts in use by their evidence, and what waits on a person', async () => {
    const { service } = build();

    const overview = await service.overview(WORKSPACE, NOW);

    expect(overview.facts).toEqual({
      inUse: 5,
      code: 1,
      people: 2,
      observed: 1,
      provisional: 0,
      unconfirmed: 1,
      needYou: 3,
    });
  });

  it('[ENG-227] counts a loose fact in the workspace and on no page, and serves the loose groups', async () => {
    const { service } = build();

    const overview = await service.overview(WORKSPACE, NOW);
    const deploy = overview.pages.find((page) => page.id === 'deploy');

    expect(overview.pages.map((page) => page.id)).toEqual(['deploy', 'empty']);
    expect(deploy?.facts.inUse).toBe(4);
    expect(deploy?.facts.needYou).toBe(1);
    expect(overview.loose).toEqual({ count: 1, groups: [] });
  });

  it('[ENG-225] gives each page its product, its trust, its use and its state', async () => {
    const { service } = build();

    const { pages } = await service.overview(WORKSPACE, NOW);
    const deploy = pages.find((page) => page.id === 'deploy');
    const empty = pages.find((page) => page.id === 'empty');

    expect(deploy).toMatchObject({
      productId: 'p1',
      summary: 'How we ship.',
      given30d: 5,
      outOfDate: true,
      rewriteWaiting: false,
    });
    expect(deploy?.facts.needYou).toBe(1);
    expect(empty).toMatchObject({
      productId: 'p2',
      summary: 'What runs the cron?',
      rewriteWaiting: true,
      outOfDate: false,
    });
  });

  it('[ENG-225] reports what agents wrote this week and what triage settled of it', async () => {
    const { service } = build();

    const { week, gardenerAt } = await service.overview(WORKSPACE, NOW);

    expect(week).toEqual({
      written: 2,
      settled: 2,
      settledObserved: 1,
      gapsClosed: 1,
    });
    expect(gardenerAt).toBe(RECENT.toISOString());
  });

  it('[ENG-225] shows only open gaps asked more than once, and the gaps an agent researches now', async () => {
    const { service, prisma } = build();

    const { gaps, research } = await service.overview(WORKSPACE, NOW);

    const { where } = prisma.pageKnowledgeGap.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      workspaceId: WORKSPACE,
      answeredAt: null,
      count: { gte: 2 },
    });
    expect(gaps).toEqual([
      {
        id: 'g1',
        query: 'redis eviction',
        count: 3,
        lastAskedAt: RECENT.toISOString(),
      },
    ]);
    expect(research).toEqual([
      {
        gapId: 'g2',
        query: 'cron owner',
        runId: 'r1',
        activity: 'Reading cron.ts',
        startedAt: RECENT.toISOString(),
      },
    ]);
  });
});
