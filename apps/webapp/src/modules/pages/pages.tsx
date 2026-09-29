import type { KnowledgeOverview, KnowledgeOverviewPage } from '@vantikhq/types';

import { RiExpandDiagonalLine } from '@remixicon/react';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';

import { useCreatePageMutation, useKnowledgeOverview } from 'services/pages';
import {
  HOME_PAGES_PER_PRODUCT,
  type ProductGroup,
  productGroups,
  SMALL_GROUP,
  weekSentence,
} from 'services/pages/overview';

import { useContextStore } from 'store/global-context-provider';

import { GapsCard } from './gaps-card';
import { Header } from './header';
import { LooseFactsCard } from './loose-facts';
import { usePageNavigation } from './navigation';
import {
  ago,
  CARD,
  FactChips,
  FIGURE_TONE,
  ProductSwatch,
  TrustBar,
} from './trust';

/**
 * Two columns that wrap to one. The main column takes almost all spare room,
 * and the side column keeps its width until the two no longer fit side by
 * side. Then the side column moves below and takes the full width.
 */
export const MAIN_COLUMN = 'min-w-0 grow-[999] basis-[480px]';
export const SIDE_COLUMN = 'min-w-0 grow basis-[320px]';

/** At most two columns of cards, and one when two do not fit. */
const CARD_GRID =
  'grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,max(240px,calc(50%_-_6px))),1fr))]';

/**
 * The Pages home: what the workspace knows and how far to trust it, the most
 * used pages of each product, the gaps agents could not close, and the facts
 * outside any page.
 */
const PagesView = observer(() => {
  const goToPage = usePageNavigation();
  const { data: overview, isLoading } = useKnowledgeOverview();
  const { mutate: createPage } = useCreatePageMutation({
    onSuccess: (page) => goToPage(page.id),
  });

  return (
    <MainLayout
      scrollable
      header={<Header onCreate={() => createPage({ title: '' })} />}
    >
      <div className="px-4 py-5 md:px-7 md:py-6 flex flex-wrap gap-6 items-start">
        <section className={cn(MAIN_COLUMN, 'flex flex-col gap-5')}>
          {overview ? (
            <>
              <Summary overview={overview} />
              <Products overview={overview} />
            </>
          ) : (
            !isLoading && (
              <p className="text-muted-foreground">
                The knowledge overview did not load.
              </p>
            )
          )}
        </section>

        <aside className={cn(SIDE_COLUMN, 'flex flex-col gap-4')}>
          {overview && (
            <GapsCard
              gaps={overview.gaps}
              research={overview.research}
              closedThisWeek={overview.week.gapsClosed}
              onWritePage={(query) => createPage({ title: query })}
            />
          )}
          {overview && <LooseFactsCard loose={overview.loose} />}
        </aside>
      </div>
    </MainLayout>
  );
});

/** The figures of the facts in use, the trust bar and the week. */
const Summary = observer(({ overview }: { overview: KnowledgeOverview }) => {
  const {
    query: { workspaceSlug },
  } = useRouter();
  const { facts } = overview;

  return (
    <div className={cn(CARD, 'px-5 py-[18px] flex flex-col gap-3.5')}>
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-semibold grow">
          What the workspace knows
        </span>
        <Link
          href={{
            pathname: '/[workspaceSlug]/pages/gardener',
            query: { workspaceSlug },
          }}
          className="flex items-center gap-2 py-1 pl-2.5 pr-1.5 rounded-lg bg-grayAlpha-50 hover:bg-grayAlpha-100 text-xs text-muted-foreground"
        >
          Gardener
          {overview.gardenerAt ? ` · ${ago(overview.gardenerAt)}` : ''}
          <RiExpandDiagonalLine size={14} />
        </Link>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <Figure value={facts.inUse} label="facts in use" />
        <Figure
          value={facts.code}
          label="confirmed by the code"
          tone={FIGURE_TONE.code}
        />
        {facts.observed > 0 ? (
          <Figure
            value={facts.observed}
            label="observed, re-checked monthly"
            tone={FIGURE_TONE.observed}
          />
        ) : (
          <Figure
            value={facts.people}
            label="confirmed by people"
            tone={FIGURE_TONE.people}
          />
        )}
        <Figure
          value={facts.needYou}
          label="need you"
          tone={FIGURE_TONE.needYou}
        />
      </div>

      <TrustBar facts={facts} />

      <p className="leading-normal text-foreground/80">
        {weekSentence(overview)}
      </p>
    </div>
  );
});

function Figure({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className={cn('text-[26px] font-semibold leading-tight', tone)}>
        {value}
      </span>
      <span className="text-foreground/75">{label}</span>
    </div>
  );
}

/**
 * The products and their most used pages. A product with a few pages shares
 * a row with the next one like it, so a short list does not take a full row.
 */
const Products = observer(({ overview }: { overview: KnowledgeOverview }) => {
  const groups = productGroups(overview);

  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground">
        No pages yet. Start one, or answer a gap that agents could not close.
      </p>
    );
  }

  const rows: ProductGroup[][] = [];

  for (const group of groups) {
    const small = group.pages.length <= SMALL_GROUP;
    const last = rows[rows.length - 1];

    if (small && last?.length === 1 && last[0].pages.length <= SMALL_GROUP) {
      last.push(group);
    } else {
      rows.push([group]);
    }
  }

  return (
    <>
      {rows.map((row) =>
        row.length === 1 && row[0].pages.length > SMALL_GROUP ? (
          <Group key={row[0].product?.id ?? 'none'} group={row[0]} wide />
        ) : (
          <div
            key={row.map((group) => group.product?.id ?? 'none').join()}
            className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,max(240px,calc(50%_-_10px))),1fr))]"
          >
            {row.map((group) => (
              <Group key={group.product?.id ?? 'none'} group={group} />
            ))}
          </div>
        ),
      )}
    </>
  );
});

const Group = observer(
  ({ group, wide = false }: { group: ProductGroup; wide?: boolean }) => {
    const {
      query: { workspaceSlug },
    } = useRouter();
    const { productsStore } = useContextStore();
    const product = group.product
      ? productsStore.getProductWithId(group.product.id)
      : undefined;
    const shown = group.pages.slice(0, HOME_PAGES_PER_PRODUCT);
    const total = group.pages.length;
    const all = {
      pathname: '/[workspaceSlug]/pages/product/[productId]',
      query: { workspaceSlug, productId: group.product?.id ?? 'none' },
    };

    return (
      <div className="flex flex-col gap-2.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <ProductSwatch
            product={group.product ? (product ?? group.product) : undefined}
          />
          <Link href={all} className="font-semibold truncate hover:underline">
            {group.product?.name ?? 'Other pages'}
          </Link>
          <span className="text-muted-foreground grow truncate">
            {total > shown.length
              ? `${shown.length} of ${total} pages · most used`
              : `${total} ${total === 1 ? 'page' : 'pages'}`}
          </span>
          {total > shown.length && (
            <Link
              href={all}
              className="font-medium text-primary whitespace-nowrap"
            >
              View all {total} →
            </Link>
          )}
        </div>

        <div className={wide ? CARD_GRID : 'flex flex-col gap-3'}>
          {shown.map((page) => (
            <PageCard key={page.id} page={page} />
          ))}
        </div>
      </div>
    );
  },
);

const PageCard = observer(({ page }: { page: KnowledgeOverviewPage }) => {
  const {
    query: { workspaceSlug },
  } = useRouter();

  return (
    <Link
      href={{
        pathname: '/[workspaceSlug]/pages/[pageId]',
        query: { workspaceSlug, pageId: page.id },
      }}
      className={cn(
        CARD,
        'px-4 py-3.5 flex flex-col gap-2 min-w-0 hover:border-grayAlpha-300 transition-colors',
      )}
    >
      <span className="text-sm font-semibold break-words">
        {page.title || 'Untitled page'}
      </span>
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
          {ago(page.updatedAt)}
        </span>
      </div>
    </Link>
  );
});

export function Pages() {
  return <PagesView />;
}

Pages.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
