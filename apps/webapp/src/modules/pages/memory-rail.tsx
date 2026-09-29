import type { ServedCitation } from '@vantikhq/types';

import { RiAddLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { Textarea } from '@vantikhq/ui/components/textarea';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';

import { PageEntryStatus, PageKind, type PageEntryType } from 'common/types';

import { useAllUsers } from 'hooks/users';

import {
  type ProvenEntry,
  useCreatePageEntryMutation,
  usePageEntryProofs,
} from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { ConsolidateDialog } from './consolidate-dialog';
import { RowMenu } from './entry-row';
import { FactTrailDialog } from './fact-trail';
import { LooseFitCard } from './loose-facts';
import { ago, CARD, Chip, NEED_YOU_BADGE, type TrustTone } from './trust';

const IN_USE: string[] = [
  PageEntryStatus.STANDING,
  PageEntryStatus.CONSOLIDATED,
];
const WAITING: string[] = [PageEntryStatus.PROPOSED, PageEntryStatus.DISPUTED];
const RETIRED: string[] = [
  PageEntryStatus.SUPERSEDED,
  PageEntryStatus.ARCHIVED,
];

type FactFilter = 'all' | 'code' | 'people' | 'observed' | 'retired';

/**
 * The facts of a page with their proof. The synced store holds the entries
 * and says when they change. The proof, which is the trust of each entry
 * and its citations, comes from the server.
 */
export function usePageFacts(pageId: string) {
  const { pageEntriesStore } = useContextStore();
  const synced: PageEntryType[] = pageEntriesStore.getEntries(pageId);
  const signature = synced
    .map((entry) => `${entry.id}:${entry.status}:${entry.updatedAt}`)
    .sort()
    .join('|');
  const { data } = usePageEntryProofs(pageId, signature);

  return { facts: data ?? [] };
}

/**
 * The facts behind a page, beside it: what agents are given with the page,
 * what each rests on, and what waits on a person.
 */
export const FactsRail = observer(
  ({ pageId, className }: { pageId: string; className?: string }) => {
    const { pagesStore } = useContextStore();
    const generated =
      pagesStore.getPageWithId(pageId)?.kind === PageKind.GENERATED;
    const { facts } = usePageFacts(pageId);

    const [filter, setFilter] = React.useState<FactFilter>('all');
    const {
      query: { workspaceSlug },
    } = useRouter();
    const [adding, setAdding] = React.useState(false);
    const [showRetired, setShowRetired] = React.useState(false);
    const [picking, setPicking] = React.useState(false);
    const [picked, setPicked] = React.useState<Set<string>>(new Set());
    const [folding, setFolding] = React.useState<PageEntryType[]>([]);
    const [opened, setOpened] = React.useState<ProvenEntry | null>(null);

    const inUse = facts.filter((fact) => IN_USE.includes(fact.status));
    const waiting = facts.filter((fact) => WAITING.includes(fact.status));
    const retired = facts.filter((fact) => RETIRED.includes(fact.status));
    const byTone = (tone: TrustTone) =>
      inUse.filter((fact) => factTone(fact) === tone);
    const counts: Record<Exclude<FactFilter, 'all'>, number> = {
      code: byTone('code').length,
      people: byTone('people').length,
      observed: byTone('observed').length,
      retired: retired.length,
    };
    const shown =
      filter === 'all'
        ? [...waiting, ...inUse]
        : filter === 'retired'
          ? retired
          : inUse.filter((fact) => factTone(fact) === filter);
    const standing = inUse.filter(
      (fact) => fact.status === PageEntryStatus.STANDING,
    );

    const toggle = (id: string) =>
      setPicked((current: Set<string>) => {
        const next = new Set(current);

        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }

        return next;
      });

    return (
      <aside className={cn('flex flex-col gap-2.5', className)}>
        <div className="flex items-center gap-2 px-0.5 pb-1">
          <span className="text-[15px] font-semibold grow">
            Facts behind this page
          </span>
          <span className="text-muted-foreground">{inUse.length} in use</span>
        </div>

        <div className="flex gap-1 flex-wrap">
          <FilterChip
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All
          </FilterChip>
          <FilterChip
            active={filter === 'code'}
            onClick={() => setFilter('code')}
          >
            By code {counts.code}
          </FilterChip>
          <FilterChip
            active={filter === 'people'}
            onClick={() => setFilter('people')}
          >
            By people {counts.people}
          </FilterChip>
          {counts.observed > 0 && (
            <FilterChip
              active={filter === 'observed'}
              onClick={() => setFilter('observed')}
            >
              Observed {counts.observed}
            </FilterChip>
          )}
          <FilterChip
            active={filter === 'retired'}
            onClick={() => setFilter('retired')}
          >
            Retired {counts.retired}
          </FilterChip>
        </div>

        {waiting.length > 0 && filter === 'all' && (
          <Link
            href={{
              pathname: '/[workspaceSlug]/pages/needs-you',
              query: { workspaceSlug, page: pageId },
            }}
            className="rounded-[10px] px-3.5 py-3 flex items-center gap-2 text-left bg-[oklch(66%_0.18_45/0.08)] border border-[oklch(66%_0.18_45/0.25)]"
          >
            <span className={NEED_YOU_BADGE}>{waiting.length}</span>
            <span className="grow leading-snug">
              {waiting.length === 1 ? 'waits' : 'wait'} on you. No agent is
              given {waiting.length === 1 ? 'it' : 'them'} until you decide.
            </span>
            <span className="font-medium whitespace-nowrap">Needs you →</span>
          </Link>
        )}

        {shown.length === 0 && (
          <div className={cn(CARD, 'px-3.5 py-3 text-muted-foreground')}>
            {facts.length === 0
              ? 'No facts yet. Agents add them as they work, and you can add one.'
              : 'None here.'}
          </div>
        )}

        {filter === 'retired'
          ? shown.map((fact) => (
              <RetiredFact
                key={fact.id}
                fact={fact}
                onOpen={() => setOpened(fact)}
              />
            ))
          : shown.map((fact, index) => (
              <React.Fragment key={fact.id}>
                <FactCard
                  fact={fact}
                  onOpen={() => setOpened(fact)}
                  picking={picking && fact.status === PageEntryStatus.STANDING}
                  picked={picked.has(fact.id)}
                  onPick={() => toggle(fact.id)}
                />
                {/* The facts outside any page that fit here come after the
                    first fact of the page, so the page leads. */}
                {index === 0 && filter === 'all' && (
                  <LooseFitCard pageId={pageId} />
                )}
              </React.Fragment>
            ))}
        {shown.length === 0 && filter === 'all' && (
          <LooseFitCard pageId={pageId} />
        )}

        {filter === 'all' && retired.length > 0 && (
          <div className="border border-dashed border-grayAlpha-300 rounded-[10px] px-3.5 py-2.5 flex flex-col gap-1.5">
            <button
              type="button"
              className="flex items-center gap-1.5 text-left"
              onClick={() => setShowRetired((shown: boolean) => !shown)}
            >
              <span className="text-xs font-semibold text-foreground/80 grow">
                Retired {retired.length}
              </span>
              <span className="text-xs text-muted-foreground">
                {showRetired ? 'Hide' : 'Show'}
              </span>
            </button>
            {showRetired &&
              retired.map((fact) => <RetiredText key={fact.id} fact={fact} />)}
          </div>
        )}

        <div className="flex items-center gap-1 flex-wrap">
          {!adding && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 px-1.5"
              onClick={() => setAdding(true)}
            >
              <RiAddLine size={14} />
              Add a fact
            </Button>
          )}
          {!generated && standing.length > 0 && !picking && !adding && (
            <Button
              variant="ghost"
              size="sm"
              className="px-1.5"
              onClick={() => setPicking(true)}
            >
              Write facts into the page
            </Button>
          )}
          {picking && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={picked.size === 0}
                onClick={() =>
                  setFolding(standing.filter((fact) => picked.has(fact.id)))
                }
              >
                Write {picked.size} into the page
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPicking(false);
                  setPicked(new Set());
                }}
              >
                Cancel
              </Button>
            </>
          )}
        </div>

        {adding && <AddFact pageId={pageId} onDone={() => setAdding(false)} />}

        <FactTrailDialog fact={opened} onClose={() => setOpened(null)} />

        <ConsolidateDialog
          pageId={pageId}
          entries={folding}
          open={folding.length > 0}
          onOpenChange={(open: boolean) => {
            if (!open) {
              setFolding([]);
              setPicked(new Set());
              setPicking(false);
            }
          }}
        />
      </aside>
    );
  },
);

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'text-xs px-2.5 py-[3px] rounded-[7px] whitespace-nowrap',
        active
          ? 'bg-background-3 font-medium shadow-[0_0_0_1px_oklch(0%_0_0/0.1)]'
          : 'text-foreground/75 hover:text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The tone of a fact's evidence. A fact that waits is the person's. */
export function factTone(fact: ProvenEntry): TrustTone | null {
  if (WAITING.includes(fact.status)) {
    return 'needYou';
  }

  switch (fact.trust) {
    case 'HUMAN_VERIFIED':
      return 'people';
    case 'GROUNDED':
      return 'code';
    case 'OBSERVED':
      return 'observed';
    default:
      return null;
  }
}

/** What a fact's trust chip says. */
export function TrustChip({ fact }: { fact: ProvenEntry }) {
  const { users } = useAllUsers();
  const tone = factTone(fact);

  if (tone === 'needYou') {
    return <Chip tone="needYou">Needs you</Chip>;
  }
  if (tone === 'people') {
    const person = users.find((user) => user.id === fact.verifiedByUserId);

    return (
      <Chip tone="people">
        Confirmed{person ? ` by ${person.fullname ?? person.username}` : ''}
      </Chip>
    );
  }
  if (tone === 'code') {
    return <Chip tone="code">Code confirms</Chip>;
  }
  if (tone === 'observed') {
    return (
      <Chip tone="observed">
        Observed {fact.lastCheckedAt ? ago(fact.lastCheckedAt) : ''}
      </Chip>
    );
  }

  return <Chip>Unconfirmed</Chip>;
}

/** "health.controller.ts 6–20", "docs.kroger.com", "ENG-42". */
export function citationLabel(citation: ServedCitation): string {
  if (citation.path) {
    const file = citation.path.split('/').pop() ?? citation.path;

    return citation.lines
      ? `${file} ${citation.lines.replace('-', '–')}`
      : file;
  }

  if (citation.target) {
    try {
      return new URL(citation.target).hostname;
    } catch {
      return citation.target;
    }
  }

  return citation.kind.toLowerCase();
}

const FactCard = observer(
  ({
    fact,
    onOpen,
    picking,
    picked,
    onPick,
  }: {
    fact: ProvenEntry;
    onOpen: () => void;
    picking: boolean;
    picked: boolean;
    onPick: () => void;
  }) => {
    const {
      query: { workspaceSlug },
    } = useRouter();
    const { users } = useAllUsers();
    const author = users.find((user) => user.id === fact.sourceUserId);
    const waiting = WAITING.includes(fact.status);
    const citations = (fact.citations ?? []).map(citationLabel);
    const meta = [
      author?.fullname ?? author?.username ?? 'An agent',
      ago(fact.createdAt),
      fact.status === PageEntryStatus.CONSOLIDATED
        ? 'in the page body'
        : IN_USE.includes(fact.status)
          ? fact.retrievalCount
            ? `given to ${fact.retrievalCount} ${fact.retrievalCount === 1 ? 'run' : 'runs'}`
            : 'not given to a run yet'
          : null,
    ].filter(Boolean);

    return (
      <div
        className={cn(
          CARD,
          'group px-3.5 py-3 flex flex-col gap-2 min-w-0',
          picked && 'border-[oklch(60%_0.13_240/0.5)]',
        )}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {picking && (
            <Checkbox
              checked={picked}
              aria-label="Write this fact into the page"
              onCheckedChange={onPick}
            />
          )}
          <span className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground">
            {(fact.kind ?? 'FACT').toUpperCase()}
          </span>
          {fact.scope && (
            <span className="font-mono text-[11px] text-muted-foreground truncate">
              {fact.scope}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 shrink-0">
            <TrustChip fact={fact} />
            {!waiting && <RowMenu entry={fact} />}
          </span>
        </div>

        <button
          type="button"
          className="text-left leading-snug whitespace-pre-wrap break-words hover:underline decoration-grayAlpha-300"
          onClick={onOpen}
        >
          {fact.content}
        </button>

        {citations.length > 0 && (
          <span className="font-mono text-[11.5px] text-foreground/65 break-words">
            {citations.join(' · ')}
          </span>
        )}

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground grow">
            {meta.join(' · ')}
          </span>
          {waiting && (
            <Link
              href={{
                pathname: '/[workspaceSlug]/pages/needs-you',
                query: { workspaceSlug, subject: fact.id },
              }}
              className="text-xs font-medium text-primary"
            >
              Decide
            </Link>
          )}
        </div>
      </div>
    );
  },
);

/** A retired fact, in the Retired filter: a card of its own. */
function RetiredFact({
  fact,
  onOpen,
}: {
  fact: ProvenEntry;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="text-left border border-dashed border-grayAlpha-300 rounded-[10px] px-3.5 py-2.5"
      onClick={onOpen}
    >
      <RetiredText fact={fact} />
    </button>
  );
}

function RetiredText({ fact }: { fact: ProvenEntry }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="leading-snug text-foreground/60 line-through break-words">
        {fact.content}
      </span>
      <span className="text-xs font-medium text-[oklch(48%_0.16_25)] dark:text-[oklch(78%_0.12_25)]">
        {fact.status === PageEntryStatus.SUPERSEDED
          ? 'Replaced by a newer fact'
          : 'Taken out of use'}{' '}
        · {ago(fact.updatedAt)}
      </span>
    </div>
  );
}

/**
 * A person writes a fact by hand. It skips the queue: a person who writes
 * it down is the review step.
 */
const AddFact = observer(
  ({ pageId, onDone }: { pageId: string; onDone: () => void }) => {
    const [content, setContent] = React.useState('');
    // The server refuses a fact the page already holds, and says which entry
    // holds it.
    const [error, setError] = React.useState<string | null>(null);

    const { mutate: create } = useCreatePageEntryMutation({
      onMutate: () => setError(null),
      onSuccess: () => {
        setContent('');
        onDone();
      },
      onError: setError,
    });

    return (
      <div className={cn(CARD, 'p-3 flex flex-col gap-2')}>
        <Textarea
          autoFocus
          rows={3}
          value={content}
          placeholder="One fact, in a sentence."
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
            setContent(event.currentTarget.value)
          }
        />
        <div className="flex items-center gap-1">
          <span className="grow text-xs text-muted-foreground">
            Agents are given it from now on.
          </span>
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={content.trim().length === 0}
            onClick={() =>
              create({ pageId, content: content.trim(), standing: true })
            }
          >
            Add
          </Button>
        </div>
        {error && <span className="text-destructive">{error}</span>}
      </div>
    );
  },
);
