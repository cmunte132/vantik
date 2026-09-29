import type {
  KnowledgeOverview,
  KnowledgeOverviewPage,
  KnowledgeOverviewProduct,
} from '@vantikhq/types';

/** The most pages a product shows on the Pages home. */
export const HOME_PAGES_PER_PRODUCT = 4;

/** A product with at most this many pages shares a row with another. */
export const SMALL_GROUP = 2;

export interface ProductGroup {
  /** Null for the pages that belong to no product. */
  product: KnowledgeOverviewProduct | null;
  /** Every page of the product, most used first. */
  pages: KnowledgeOverviewPage[];
}

/** Most used first; then the most facts in use; then the newest change. */
export function byUse(a: KnowledgeOverviewPage, b: KnowledgeOverviewPage) {
  return (
    b.given30d - a.given30d ||
    b.facts.inUse - a.facts.inUse ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

/**
 * The pages of each product, most used first. The products with the most
 * use come first, and the pages of no product come last.
 */
export function productGroups(overview: KnowledgeOverview): ProductGroup[] {
  const groups = new Map<string | null, KnowledgeOverviewPage[]>();

  for (const page of overview.pages) {
    groups.set(page.productId, [...(groups.get(page.productId) ?? []), page]);
  }

  const products = new Map(
    overview.products.map((product) => [product.id, product]),
  );
  const use = (pages: KnowledgeOverviewPage[]) =>
    pages.reduce((total, page) => total + page.given30d, 0);

  return [...groups.entries()]
    .map(([productId, pages]) => ({
      product: productId ? (products.get(productId) ?? null) : null,
      pages: [...pages].sort(byUse),
    }))
    .sort(
      (a, b) =>
        Number(a.product === null) - Number(b.product === null) ||
        use(b.pages) - use(a.pages) ||
        b.pages.length - a.pages.length ||
        (a.product?.name ?? '').localeCompare(b.product?.name ?? ''),
    );
}

export type PageFilter = 'all' | 'attention' | 'generated' | 'empty';

/** Whether a page waits on a person, or its body no longer holds. */
export function needsAttention(page: KnowledgeOverviewPage): boolean {
  return page.facts.needYou > 0 || page.outOfDate || page.rewriteWaiting;
}

export const PAGE_FILTERS: Record<
  PageFilter,
  (page: KnowledgeOverviewPage) => boolean
> = {
  all: () => true,
  attention: needsAttention,
  generated: (page) => page.kind === 'GENERATED',
  empty: (page) => page.facts.inUse === 0,
};

export type PageSort = 'used' | 'updated' | 'facts' | 'title';

export const PAGE_SORTS: Record<
  PageSort,
  { label: string; compare: typeof byUse }
> = {
  used: { label: 'Most used', compare: byUse },
  updated: {
    label: 'Recently updated',
    compare: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  },
  facts: {
    label: 'Most facts',
    compare: (a, b) => b.facts.inUse - a.facts.inUse || byUse(a, b),
  },
  title: {
    label: 'Title',
    compare: (a, b) => a.title.localeCompare(b.title),
  },
};

/** A row of the product's page list: a page, and how deep in its tree. */
export interface PageRow {
  page: KnowledgeOverviewPage;
  depth: number;
  /** The last child of its parent, which ends the tree line. */
  last: boolean;
}

/**
 * The pages of one product as rows. Each sub-page follows its parent, and
 * siblings are in the order of `compare`. A page whose parent is in another
 * product, or is filtered out, starts a tree of its own.
 */
export function pageRows(
  pages: KnowledgeOverviewPage[],
  compare: typeof byUse,
): PageRow[] {
  const ids = new Set(pages.map((page) => page.id));
  const children = new Map<string | null, KnowledgeOverviewPage[]>();

  for (const page of pages) {
    const parent =
      page.parentId && ids.has(page.parentId) ? page.parentId : null;

    children.set(parent, [...(children.get(parent) ?? []), page]);
  }

  const rows: PageRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    const siblings = [...(children.get(parent) ?? [])].sort(compare);

    siblings.forEach((page, index) => {
      if (seen.has(page.id)) {
        return;
      }

      seen.add(page.id);
      rows.push({ page, depth, last: index === siblings.length - 1 });
      walk(page.id, depth + 1);
    });
  };

  walk(null, 0);

  return rows;
}

/** The pages of a product in the order the product's list shows them. */
export function filteredPages(
  pages: KnowledgeOverviewPage[],
  filter: PageFilter,
  text: string,
): KnowledgeOverviewPage[] {
  const needle = text.trim().toLowerCase();

  return pages.filter(
    (page) =>
      PAGE_FILTERS[filter](page) &&
      (!needle ||
        page.title.toLowerCase().includes(needle) ||
        (page.summary ?? '').toLowerCase().includes(needle)),
  );
}

/**
 * The week in one sentence: what agents wrote, what the gardener settled
 * without a person, and what waits on the team.
 */
export function weekSentence(overview: KnowledgeOverview): string {
  const { week, facts, gaps } = overview;
  const parts: string[] = [];

  if (week.written === 0) {
    parts.push('Agents wrote no facts this week.');
  } else {
    const code = week.settled - week.settledObserved;
    const kinds = [
      code ? `the code confirms ${code}` : null,
      week.settledObserved
        ? `${week.settledObserved} ${week.settledObserved === 1 ? 'is a dated observation' : 'are dated observations'} of outside services`
        : null,
    ].filter(Boolean);
    const verb =
      overview.autoTriage === 'on' ? 'settled' : 'would have settled';
    const settled =
      week.settled === 0
        ? ' The gardener settled none of them without you.'
        : ` The gardener ${verb} ${week.settled} of them without you${
            kinds.length ? `: ${kinds.join(', and ')}.` : '.'
          }`;

    parts.push(
      `This week agents wrote ${week.written} ${week.written === 1 ? 'fact' : 'facts'}.${settled}`,
    );
  }

  if (facts.needYou > 0) {
    parts.push(
      `${facts.needYou} ${facts.needYou === 1 ? 'needs a decision' : 'need a decision'} only the team can make.`,
    );
  }
  if (gaps.length > 0) {
    parts.push(
      `${gaps.length} agent ${gaps.length === 1 ? 'question is' : 'questions are'} still open.`,
    );
  }

  return parts.join(' ');
}
