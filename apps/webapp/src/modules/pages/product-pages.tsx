import type { KnowledgeOverviewPage } from '@vantikhq/types';

import {
  RiArrowDownSLine,
  RiLayoutGridLine,
  RiListUnordered,
  RiSearchLine,
} from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';

import { useLocalCommonState } from 'hooks/use-local-state';

import { useCreatePageMutation, useKnowledgeOverview } from 'services/pages';
import {
  filteredPages,
  PAGE_FILTERS,
  PAGE_SORTS,
  type PageFilter,
  pageRows,
  type PageRow,
  type PageSort,
} from 'services/pages/overview';

import { useContextStore } from 'store/global-context-provider';

import { Header } from './header';
import { usePageNavigation } from './navigation';
import {
  age,
  ago,
  CARD,
  FactChips,
  ProductSwatch,
  sumFacts,
  TrustBar,
  trustSentence,
} from './trust';
import { useWidth } from './use-width';

const FILTER_LABELS: Record<PageFilter, string> = {
  all: 'All',
  attention: 'Needs attention',
  generated: 'Generated',
  empty: 'No facts',
};

/** The table needs this much room. Below it, each page is one block. */
const TABLE_MIN_WIDTH = 720;

const TABLE_COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_250px_60px_90px_80px] gap-4 items-center';

/** The product id in the route for the pages of no product. */
export const NO_PRODUCT = 'none';

/**
 * Every page of one product: filter it, sort it, and read the trust of each
 * page's facts at a glance. The Pages home shows only the most used four.
 */
const ProductPagesView = observer(() => {
  const router = useRouter();
  const productId = router.query.productId as string;
  const goToPage = usePageNavigation();
  const { productsStore } = useContextStore();
  const { data: overview } = useKnowledgeOverview();
  const { mutate: createPage } = useCreatePageMutation({
    onSuccess: (page) => goToPage(page.id),
  });

  const [text, setText] = React.useState('');
  const [filter, setFilter] = React.useState<PageFilter>('all');
  const [sort, setSort] = useLocalCommonState<PageSort>('pagesSort', 'used');
  const [view, setView] = useLocalCommonState<'list' | 'grid'>(
    'pagesView',
    'list',
  );
  const [ref, width] = useWidth<HTMLDivElement>();

  const none = productId === NO_PRODUCT;
  const product = none ? undefined : productsStore.getProductWithId(productId);
  const name =
    product?.name ??
    overview?.products.find((candidate) => candidate.id === productId)?.name ??
    (none ? 'Other pages' : '');
  const pages = (overview?.pages ?? []).filter(
    (page) => page.productId === (none ? null : productId),
  );
  const facts = sumFacts(pages.map((page) => page.facts));
  const shown = filteredPages(pages, filter, text);
  const compare = PAGE_SORTS[sort]?.compare ?? PAGE_SORTS.used.compare;
  const rows = pageRows(shown, compare);
  const table = view === 'list' && width >= TABLE_MIN_WIDTH;

  return (
    <MainLayout scrollable header={<Header crumbs={[{ label: name }]} />}>
      <div ref={ref} className="px-4 py-5 md:px-6 flex flex-col gap-4 min-w-0">
        <div className="flex items-center gap-3.5 flex-wrap">
          <ProductSwatch
            product={product ?? (none || !name ? undefined : { name })}
            large
          />
          <div className="flex flex-col gap-0.5 grow min-w-[200px]">
            <span className="text-xl font-semibold">{name}</span>
            <span className="text-foreground/80">
              {pages.length} {pages.length === 1 ? 'page' : 'pages'} ·{' '}
              {facts.inUse} facts in use
            </span>
          </div>
          <div className="flex flex-col gap-1.5 w-[220px] max-w-full">
            <TrustBar facts={facts} />
            <span className="text-xs text-muted-foreground text-right">
              {trustSentence(facts)}
            </span>
          </div>
          <button
            type="button"
            className="bg-grayAlpha-100 hover:bg-grayAlpha-200 rounded-md px-3 py-1.5 font-medium"
            onClick={() => createPage({ title: '' })}
          >
            + New page
          </button>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <label className="flex items-center gap-2 w-[240px] max-w-full px-2.5 py-1.5 rounded-lg bg-background-3 shadow-[0_0_0_1px_oklch(0%_0_0/0.1)] text-muted-foreground">
            <RiSearchLine size={14} className="shrink-0" />
            <input
              value={text}
              placeholder="Filter pages"
              aria-label="Filter pages"
              className="bg-transparent outline-none text-foreground placeholder:text-muted-foreground min-w-0 grow"
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </label>

          <Segmented>
            {(Object.keys(FILTER_LABELS) as PageFilter[]).map((key) => (
              <Segment
                key={key}
                active={filter === key}
                onClick={() => setFilter(key)}
              >
                {FILTER_LABELS[key]} {pages.filter(PAGE_FILTERS[key]).length}
              </Segment>
            ))}
          </Segmented>

          <span className="grow" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-grayAlpha-100 hover:bg-grayAlpha-200"
              >
                Sort: {PAGE_SORTS[sort]?.label ?? PAGE_SORTS.used.label}
                <RiArrowDownSLine size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(value: string) => setSort(value as PageSort)}
              >
                {(Object.keys(PAGE_SORTS) as PageSort[]).map((key) => (
                  <DropdownMenuRadioItem key={key} value={key}>
                    {PAGE_SORTS[key].label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Segmented>
            <Segment
              active={view === 'list'}
              label="List"
              onClick={() => setView('list')}
            >
              <RiListUnordered size={14} />
            </Segment>
            <Segment
              active={view === 'grid'}
              label="Grid"
              onClick={() => setView('grid')}
            >
              <RiLayoutGridLine size={14} />
            </Segment>
          </Segmented>
        </div>

        {rows.length === 0 ? (
          <div className={cn(CARD, 'p-6 text-muted-foreground')}>
            {pages.length === 0
              ? 'No pages in this product yet.'
              : 'No page matches.'}
          </div>
        ) : view === 'grid' ? (
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))]">
            {rows.map(({ page }) => (
              <GridCard key={page.id} page={page} />
            ))}
          </div>
        ) : (
          <div className={cn(CARD, 'flex flex-col overflow-hidden')}>
            {table && (
              <div
                className={cn(
                  TABLE_COLUMNS,
                  'px-[18px] py-2.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground',
                )}
              >
                <span>PAGE</span>
                <span>FACTS BEHIND IT</span>
                <span className="text-right">FACTS</span>
                <span className="text-right">GIVEN, 30 D</span>
                <span className="text-right">UPDATED</span>
              </div>
            )}
            {rows.map((row, index) => (
              <Row
                key={row.page.id}
                row={row}
                table={table}
                first={index === 0 && !table}
              />
            ))}
          </div>
        )}
      </div>
    </MainLayout>
  );
});

function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-0.5 p-0.5 bg-grayAlpha-100 rounded-lg flex-wrap">
      {children}
    </div>
  );
}

function Segment({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex items-center px-2.5 py-1 rounded-md text-xs whitespace-nowrap',
        active
          ? 'bg-background-3 font-medium shadow-[0_1px_2px_oklch(0%_0_0/0.08)]'
          : 'text-foreground/80 hover:text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function usePageHref(pageId: string) {
  const {
    query: { workspaceSlug },
  } = useRouter();

  return {
    pathname: '/[workspaceSlug]/pages/[pageId]',
    query: { workspaceSlug, pageId },
  };
}

/** The title, the summary and the tree line of a page. */
function PageCell({ row }: { row: PageRow }) {
  const { page, depth, last } = row;
  const href = usePageHref(page.id);

  return (
    <div className="flex gap-1.5 min-w-0">
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="w-[22px] shrink-0 self-stretch relative"
          aria-hidden
        >
          {level === depth - 1 && (
            <>
              <span
                className={cn(
                  'absolute left-2 -top-2.5 border-l-[1.5px] border-grayAlpha-300',
                  last ? 'bottom-1/2' : '-bottom-2.5',
                )}
              />
              <span className="absolute left-2 top-1/2 w-2.5 border-t-[1.5px] border-grayAlpha-300" />
            </>
          )}
        </span>
      ))}
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Link href={href} className="font-semibold truncate hover:underline">
            {page.title || 'Untitled page'}
          </Link>
          {page.kind === 'GENERATED' && (
            <span className="text-[11px] font-semibold tracking-[0.03em] text-muted-foreground border border-grayAlpha-300 rounded-[5px] px-[5px]">
              GENERATED
            </span>
          )}
        </div>
        {page.summary && (
          <span className="text-xs text-foreground/75 truncate">
            {page.summary}
          </span>
        )}
      </div>
    </div>
  );
}

const Row = observer(
  ({ row, table, first }: { row: PageRow; table: boolean; first: boolean }) => {
    const { page } = row;
    const chips = (
      <div className="flex gap-1 flex-wrap">
        <FactChips
          facts={page.facts}
          outOfDate={page.outOfDate}
          rewriteWaiting={page.rewriteWaiting}
        />
      </div>
    );

    if (table) {
      return (
        <div
          className={cn(
            TABLE_COLUMNS,
            'px-[18px] py-2.5 border-t border-grayAlpha-100 hover:bg-[oklch(60%_0.13_240/0.05)]',
          )}
        >
          <PageCell row={row} />
          {chips}
          <span className="text-right font-medium">{page.facts.inUse}</span>
          <span className="text-right text-foreground/80">
            {page.given30d}×
          </span>
          <span className="text-right text-xs text-muted-foreground">
            {age(page.updatedAt)}
          </span>
        </div>
      );
    }

    return (
      <div
        className={cn(
          'px-4 py-3 flex flex-col gap-2 hover:bg-[oklch(60%_0.13_240/0.05)]',
          !first && 'border-t border-grayAlpha-100',
        )}
      >
        <PageCell row={row} />
        <div className={cn(row.depth > 0 && 'pl-7')}>{chips}</div>
        <span
          className={cn(
            'text-xs text-muted-foreground',
            row.depth > 0 && 'pl-7',
          )}
        >
          {page.facts.inUse} facts · given {page.given30d}× in 30 d ·{' '}
          {ago(page.updatedAt)}
        </span>
      </div>
    );
  },
);

const GridCard = observer(({ page }: { page: KnowledgeOverviewPage }) => {
  const href = usePageHref(page.id);

  return (
    <Link
      href={href}
      className={cn(
        CARD,
        'px-4 py-3.5 flex flex-col gap-2 min-w-0 hover:border-grayAlpha-300',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-semibold truncate">
          {page.title || 'Untitled page'}
        </span>
        {page.kind === 'GENERATED' && (
          <span className="text-[11px] font-semibold text-muted-foreground border border-grayAlpha-300 rounded-[5px] px-[5px]">
            GENERATED
          </span>
        )}
      </div>
      {page.summary && (
        <span className="text-foreground/75 leading-snug line-clamp-2 break-words">
          {page.summary}
        </span>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <FactChips
          facts={page.facts}
          outOfDate={page.outOfDate}
          rewriteWaiting={page.rewriteWaiting}
        />
        <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
          {page.given30d}× · {age(page.updatedAt)}
        </span>
      </div>
    </Link>
  );
});

export function ProductPages() {
  return <ProductPagesView />;
}

ProductPages.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
