import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus } from 'common/types';

import { useAllUsers } from 'hooks/users';

import type { ProvenEntry } from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { citationLabel, TrustChip } from './memory-rail';
import { moveDetail } from './trail';
import { age, ago } from './trust';

/** The colour of the dot of each kind of step on the trail. */
const DOT = {
  written: 'bg-[oklch(70%_0_0)]',
  code: 'bg-[oklch(64.93%_0.107_154)]',
  people: 'bg-[oklch(60%_0.13_240)]',
  moved: 'bg-[oklch(60%_0.13_240)]',
  waiting: 'bg-[oklch(66%_0.18_45)]',
  retired: 'bg-[oklch(61.34%_0.162_23.58)]',
} as const;

interface Step {
  key: string;
  dot: keyof typeof DOT;
  title: string;
  detail: React.ReactNode;
}

const DATE = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * One fact and its trail: who wrote it, what it rests on, what people
 * decided, and each move between pages.
 */
export const FactTrailDialog = observer(
  ({ fact, onClose }: { fact: ProvenEntry | null; onClose: () => void }) => {
    return (
      <Dialog open={Boolean(fact)} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="p-0 gap-0 min-w-[min(520px,calc(100vw-32px))] sm:max-w-[520px]">
          <DialogHeader className="text-left px-5 h-[50px] justify-center border-b border-border">
            <DialogTitle className="text-sm font-semibold">Fact</DialogTitle>
          </DialogHeader>
          {fact && <Trail fact={fact} />}
        </DialogContent>
      </Dialog>
    );
  },
);

const Trail = observer(({ fact }: { fact: ProvenEntry }) => {
  const { pagesStore } = useContextStore();
  const { users } = useAllUsers();
  const nameOf = (userId?: string | null) => {
    const user = users.find((candidate) => candidate.id === userId);

    return user?.fullname ?? user?.username ?? null;
  };
  const titleOf = (pageId: string | null) =>
    pageId
      ? pagesStore.getPageWithId(pageId)?.title || 'Untitled page'
      : 'no page';

  const moves = fact.moves ?? [];
  const lastMove = moves[moves.length - 1];
  const steps: Step[] = [
    {
      key: 'written',
      dot: 'written',
      title: `Written by ${nameOf(fact.sourceUserId) ?? 'an agent'}`,
      detail: [
        fact.sourceSession ? `Session ${fact.sourceSession.slice(0, 8)}` : null,
        DATE_TIME.format(new Date(fact.createdAt)),
      ]
        .filter(Boolean)
        .join(' · '),
    },
  ];

  const citations = fact.citations ?? [];

  if (citations.length > 0) {
    steps.push({
      key: 'cited',
      dot: fact.trust === 'GROUNDED' ? 'code' : 'written',
      title:
        fact.trust === 'GROUNDED'
          ? 'The cited lines hold'
          : `It cites ${citations.map(citationLabel).join(', ')}`,
      detail:
        fact.lastCheckedSha && fact.lastCheckedAt
          ? `The server read them itself at ${fact.lastCheckedSha.slice(0, 8)}, ${ago(fact.lastCheckedAt)}`
          : 'The server has not read the cited lines yet.',
    });
  }

  if (fact.verifiedAt) {
    steps.push({
      key: 'confirmed',
      dot: 'people',
      title: `Confirmed by ${nameOf(fact.verifiedByUserId) ?? 'a person'}`,
      detail: DATE.format(new Date(fact.verifiedAt)),
    });
  }

  for (const [index, move] of moves.entries()) {
    steps.push({
      key: `move-${index}`,
      dot: 'moved',
      title: `Moved under ${titleOf(move.toPageId)}`,
      detail: moveDetail(move, fact.scope, titleOf, nameOf(move.movedById)),
    });
  }

  if (fact.status === PageEntryStatus.PROPOSED) {
    steps.push({
      key: 'waiting',
      dot: 'waiting',
      title: 'Waits on a person',
      detail: 'No agent is given it until a person decides.',
    });
  } else if (
    fact.status === PageEntryStatus.SUPERSEDED ||
    fact.status === PageEntryStatus.ARCHIVED
  ) {
    steps.push({
      key: 'retired',
      dot: 'retired',
      title:
        fact.status === PageEntryStatus.SUPERSEDED
          ? 'Replaced by a newer fact'
          : 'Taken out of use',
      detail: DATE.format(new Date(fact.updatedAt)),
    });
  }

  const since = lastMove?.createdAt ?? fact.createdAt;

  return (
    <div className="p-5 flex flex-col gap-[18px] max-h-[75vh] overflow-y-auto">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground">
            {(fact.kind ?? 'FACT').toUpperCase()}
          </span>
          <TrustChip fact={fact} />
          {fact.scope && (
            <span className="font-mono text-[11.5px] px-1.5 py-0.5 rounded-[5px] bg-grayAlpha-100">
              {fact.scope}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {fact.pageId ? `on ${titleOf(fact.pageId)}` : 'outside any page'},
            since {DATE.format(new Date(since))}
          </span>
        </div>
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
          {fact.content}
        </p>
      </div>

      <div className="flex flex-col">
        <span className="text-xs font-semibold text-foreground/80 mb-2.5">
          Why it is trusted
        </span>
        {steps.map((step, index) => (
          <div key={step.key} className="flex gap-3">
            <div className="flex flex-col items-center w-3">
              <span
                className={cn(
                  'w-[9px] h-[9px] rounded-full mt-1',
                  DOT[step.dot],
                )}
              />
              {index < steps.length - 1 && (
                <span className="grow w-px bg-grayAlpha-200" />
              )}
            </div>
            <div className="flex flex-col gap-0.5 pb-3.5 min-w-0">
              <span className="font-medium">{step.title}</span>
              <span className="text-xs text-muted-foreground">
                {step.detail}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-4 px-3.5 py-3 rounded-[9px] bg-grayAlpha-50">
        <div className="flex flex-col">
          <span className="text-lg font-semibold">{fact.retrievalCount}</span>
          <span className="text-xs text-muted-foreground">
            {fact.retrievalCount === 1 ? 'run given it' : 'runs given it'}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-lg font-semibold">
            {fact.lastServedAt ? age(fact.lastServedAt) : '–'}
          </span>
          <span className="text-xs text-muted-foreground">since last use</span>
        </div>
      </div>
    </div>
  );
});
