import type { KnowledgeOverview, KnowledgeOverviewPage } from '@vantikhq/types';

import { describe, expect, it } from 'vitest';

import {
  byUse,
  filteredPages,
  pageRows,
  productGroups,
  weekSentence,
} from './overview';

function page(
  id: string,
  overrides: Partial<KnowledgeOverviewPage> = {},
): KnowledgeOverviewPage {
  return {
    id,
    title: id,
    parentId: null,
    kind: 'AUTHORED',
    summary: null,
    updatedAt: '2026-09-28T10:00:00.000Z',
    productId: null,
    facts: {
      inUse: 0,
      code: 0,
      people: 0,
      observed: 0,
      unconfirmed: 0,
      needYou: 0,
    },
    rewriteWaiting: false,
    outOfDate: false,
    given30d: 0,
    ...overrides,
  };
}

function overview(
  overrides: Partial<KnowledgeOverview> = {},
): KnowledgeOverview {
  return {
    autoTriage: 'on',
    facts: page('x').facts,
    week: { written: 0, settled: 0, settledObserved: 0, gapsClosed: 0 },
    gardenerAt: null,
    pages: [],
    products: [
      { id: 'app', name: 'Vantik App' },
      { id: 'pod', name: 'PodReader' },
    ],
    gaps: [],
    research: [],
    ...overrides,
  };
}

describe('productGroups', () => {
  it('[ENG-225] puts the most used product first, its most used page first, and pages of no product last', () => {
    const groups = productGroups(
      overview({
        pages: [
          page('loose', { given30d: 100 }),
          page('pod-1', { productId: 'pod', given30d: 3 }),
          page('app-1', { productId: 'app', given30d: 5 }),
          page('app-2', { productId: 'app', given30d: 9 }),
        ],
      }),
    );

    expect(groups.map((group) => group.product?.id ?? null)).toEqual([
      'app',
      'pod',
      null,
    ]);
    expect(groups[0].pages.map((p) => p.id)).toEqual(['app-2', 'app-1']);
  });
});

describe('pageRows', () => {
  it('[ENG-225] puts each sub-page under its parent, and marks the last child', () => {
    const rows = pageRows(
      [
        page('child-b', { parentId: 'root', given30d: 1 }),
        page('root', { given30d: 5 }),
        page('child-a', { parentId: 'root', given30d: 2 }),
        page('orphan', { parentId: 'elsewhere' }),
      ],
      byUse,
    );

    expect(rows.map((row) => [row.page.id, row.depth, row.last])).toEqual([
      ['root', 0, false],
      ['child-a', 1, false],
      ['child-b', 1, true],
      ['orphan', 0, true],
    ]);
  });
});

describe('filteredPages', () => {
  const pages = [
    page('a', { facts: { ...page('a').facts, needYou: 1, inUse: 2 } }),
    page('b', { kind: 'GENERATED', summary: 'Redis eviction' }),
    page('c', { outOfDate: true, facts: { ...page('c').facts, inUse: 1 } }),
  ];

  it('[ENG-225] keeps the pages each filter names', () => {
    const ids = (list: KnowledgeOverviewPage[]) => list.map((p) => p.id);

    expect(ids(filteredPages(pages, 'attention', ''))).toEqual(['a', 'c']);
    expect(ids(filteredPages(pages, 'generated', ''))).toEqual(['b']);
    expect(ids(filteredPages(pages, 'empty', ''))).toEqual(['b']);
    expect(ids(filteredPages(pages, 'all', 'redis'))).toEqual(['b']);
  });
});

describe('weekSentence', () => {
  it('[ENG-225] says what agents wrote, what was settled, and what waits', () => {
    expect(
      weekSentence(
        overview({
          week: { written: 24, settled: 21, settledObserved: 8, gapsClosed: 0 },
          facts: { ...page('x').facts, needYou: 3 },
          gaps: [
            { id: 'g', query: 'q', count: 2, lastAskedAt: '' },
            { id: 'h', query: 'r', count: 2, lastAskedAt: '' },
          ],
        }),
      ),
    ).toBe(
      'This week agents wrote 24 facts. The gardener settled 21 of them without you: the code confirms 13, and 8 are dated observations of outside services. 3 need a decision only the team can make. 2 agent questions are still open.',
    );
  });

  it('[ENG-225] says "would have" while triage runs in shadow', () => {
    expect(
      weekSentence(
        overview({
          autoTriage: 'shadow',
          week: { written: 2, settled: 1, settledObserved: 0, gapsClosed: 0 },
        }),
      ),
    ).toBe(
      'This week agents wrote 2 facts. The gardener would have settled 1 of them without you: the code confirms 1.',
    );
  });
});
