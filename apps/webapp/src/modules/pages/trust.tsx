import type { KnowledgeFactCounts } from '@vantikhq/types';

import { cn } from '@vantikhq/ui/lib/utils';
import * as React from 'react';

/**
 * The colours of the evidence behind a fact. Colour on the Pages views
 * means one of these things and nothing else: the code confirms it, a
 * person confirmed it, the server observed an outside page, or it waits on
 * a person. Everything else is grey.
 */
export type TrustTone = 'code' | 'people' | 'observed' | 'needYou' | 'stale';

/** The small rounded label for each tone, light and dark. */
export const CHIP_TONE: Record<TrustTone, string> = {
  code: 'text-[oklch(42%_0.1_154)] bg-[oklch(64.93%_0.107_154/0.15)] dark:text-[oklch(78%_0.1_154)]',
  people:
    'text-[oklch(45%_0.13_240)] bg-[oklch(60%_0.13_240/0.13)] dark:text-[oklch(78%_0.1_240)]',
  observed:
    'text-[oklch(40%_0.08_100)] bg-[oklch(72%_0.11_100/0.2)] dark:text-[oklch(82%_0.1_100)]',
  needYou:
    'text-[oklch(48%_0.17_45)] bg-[oklch(66%_0.18_45/0.15)] dark:text-[oklch(80%_0.14_45)]',
  stale:
    'text-[oklch(48%_0.16_25)] bg-[oklch(61.34%_0.162_23.58/0.13)] dark:text-[oklch(78%_0.12_25)]',
};

/** The segment of a trust bar for each tone. */
const BAR_TONE: Record<Exclude<TrustTone, 'stale'>, string> = {
  code: 'bg-[oklch(64.93%_0.107_154)]',
  observed: 'bg-[oklch(72%_0.11_100)]',
  people: 'bg-[oklch(60%_0.13_240)]',
  needYou: 'bg-[oklch(66%_0.18_45)]',
};

/** The large figure for each tone, on the summary card. */
export const FIGURE_TONE: Record<Exclude<TrustTone, 'stale'>, string> = {
  code: 'text-[oklch(46%_0.1_154)] dark:text-[oklch(75%_0.1_154)]',
  observed: 'text-[oklch(48%_0.09_100)] dark:text-[oklch(80%_0.1_100)]',
  people: 'text-[oklch(45%_0.13_240)] dark:text-[oklch(75%_0.1_240)]',
  needYou: 'text-[oklch(55%_0.19_45)] dark:text-[oklch(75%_0.15_45)]',
};

/** The orange of a count that waits on a person. */
export const NEED_YOU_BADGE =
  'text-white bg-[oklch(58%_0.19_45)] rounded-full px-[7px] text-xs font-semibold leading-[18px]';

/** A white card on the grey canvas: the one surface the Pages views use. */
export const CARD =
  'bg-background-3 border border-grayAlpha-100 rounded-[10px] shadow-none';

export function Chip({
  tone,
  children,
  className,
}: {
  tone?: TrustTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap',
        tone ? CHIP_TONE[tone] : 'bg-grayAlpha-100',
        className,
      )}
    >
      {children}
    </span>
  );
}

interface PageState {
  facts: KnowledgeFactCounts;
  outOfDate?: boolean;
  rewriteWaiting?: boolean;
}

/**
 * What the facts behind a page rest on, as chips. A page with no facts says
 * so, in grey.
 */
export function FactChips({ facts, outOfDate, rewriteWaiting }: PageState) {
  const chips: Array<[TrustTone, string]> = [];

  if (outOfDate) {
    chips.push(['stale', 'Body out of date']);
  }
  if (rewriteWaiting) {
    chips.push(['needYou', 'Rewrite waiting']);
  }
  if (facts.code) {
    chips.push(['code', `${facts.code} by code`]);
  }
  if (facts.people) {
    chips.push(['people', `${facts.people} by people`]);
  }
  if (facts.observed) {
    chips.push(['observed', `${facts.observed} observed`]);
  }

  // A rewrite already says that the page waits on a person.
  const waiting = facts.needYou - (rewriteWaiting ? 1 : 0);

  if (waiting > 0) {
    chips.push(['needYou', `${waiting} need you`]);
  }

  if (chips.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {facts.inUse ? `${facts.inUse} unconfirmed` : 'No facts yet'}
      </span>
    );
  }

  return (
    <>
      {chips.map(([tone, label]) => (
        <Chip key={label} tone={tone}>
          {label}
        </Chip>
      ))}
    </>
  );
}

/** The share of the facts in use that rests on each kind of evidence. */
export function TrustBar({
  facts,
  className,
}: {
  facts: KnowledgeFactCounts;
  className?: string;
}) {
  const segments: Array<[keyof typeof BAR_TONE, number]> = [
    ['code', facts.code],
    ['observed', facts.observed],
    ['people', facts.people],
    ['needYou', facts.needYou],
  ];

  return (
    <div
      className={cn('flex h-2 rounded overflow-hidden gap-0.5', className)}
      role="img"
      aria-label={trustSentence(facts)}
    >
      {segments.some(([, count]) => count > 0) ? (
        segments
          .filter(([, count]) => count > 0)
          .map(([tone, count]) => (
            <div
              key={tone}
              className={BAR_TONE[tone]}
              style={{ flexGrow: count }}
            />
          ))
      ) : (
        <div className="grow bg-grayAlpha-100" />
      )}
    </div>
  );
}

export function trustSentence(facts: KnowledgeFactCounts): string {
  return [
    `${facts.code} by code`,
    `${facts.people} by people`,
    `${facts.observed} observed`,
    `${facts.needYou} need you`,
  ].join(' · ');
}

/** Sums the counts of several pages. */
export function sumFacts(all: KnowledgeFactCounts[]): KnowledgeFactCounts {
  return all.reduce(
    (total, facts) => ({
      inUse: total.inUse + facts.inUse,
      code: total.code + facts.code,
      people: total.people + facts.people,
      observed: total.observed + facts.observed,
      unconfirmed: total.unconfirmed + facts.unconfirmed,
      needYou: total.needYou + facts.needYou,
    }),
    { inUse: 0, code: 0, people: 0, observed: 0, unconfirmed: 0, needYou: 0 },
  );
}

/** "4 min", "17 h", "3 d": the age of a thing, short. */
export function age(at: string | Date | null | undefined, now = Date.now()) {
  if (!at) {
    return '';
  }

  const minutes = Math.max(
    0,
    Math.round((now - new Date(at).getTime()) / 60000),
  );

  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)} h`;
  }
  if (minutes < 60 * 24 * 60) {
    return `${Math.round(minutes / (60 * 24))} d`;
  }

  return `${Math.round(minutes / (60 * 24 * 30))} mo`;
}

/** "17 h ago", or "just now". */
export function ago(at: string | Date | null | undefined) {
  const short = age(at);

  return short === 'now' ? 'just now' : short && `${short} ago`;
}

const PRODUCT_HUES = [90, 55, 300, 245, 154, 20, 200, 330];

/**
 * A product's colour. A product with no colour set takes one from its id, so
 * that it keeps the same colour on every view.
 */
export function productColor(product?: {
  id: string;
  color?: string | null;
}): string {
  if (!product) {
    return 'oklch(0% 0 0 / 0.15)';
  }
  if (product.color) {
    return product.color;
  }

  let hash = 0;

  for (const char of product.id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return `oklch(62% 0.12 ${PRODUCT_HUES[hash % PRODUCT_HUES.length]})`;
}

export function ProductSwatch({
  product,
  size = 14,
}: {
  product?: { id: string; color?: string | null };
  size?: number;
}) {
  return (
    <span
      className="shrink-0 rounded"
      style={{
        width: size,
        height: size,
        background: productColor(product),
        borderRadius: size > 20 ? 8 : 4,
      }}
    />
  );
}
