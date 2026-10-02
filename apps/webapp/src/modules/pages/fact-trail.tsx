import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import {
  KnowledgeReviewReasonEnum,
  type PageEntryTriageStep,
  type ServedCitation,
} from '@vantikhq/types';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus } from 'common/types';

import { useAllUsers } from 'hooks/users';

import type { ProvenEntry } from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { citationLabel, TrustChip } from './memory-rail';
import {
  allContradicted,
  CHECK_VERDICTS,
  REASON_LABELS,
} from './review-reasons';
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

/** The dialog's title: what kind of knowledge it is. */
const KIND_TITLE: Record<string, string> = {
  FACT: 'Fact',
  DECISION: 'Decision',
  CONVENTION: 'Convention',
};

/**
 * What the server found when it last read the citations, said for what they
 * are: lines of code are read at a commit, an issue or a page only exists.
 */
function citationDetail(fact: ProvenEntry): string {
  const citations = fact.citations ?? [];
  const results = citations.map((citation) => citation.result);

  if (results.some((result) => result === 'CHANGED' || result === 'MISSING')) {
    return 'A citation no longer holds: what it points at changed or is gone.';
  }

  if (results.some((result) => !result || result === 'UNKNOWN')) {
    return 'The server has not been able to read every citation yet.';
  }

  if (fact.lastCheckedSha && fact.lastCheckedAt) {
    return `The server read the lines itself at ${fact.lastCheckedSha.slice(0, 8)}, ${ago(fact.lastCheckedAt)}.`;
  }

  const checkedAt = citations
    .map((citation) => citation.checkedAt)
    .filter((at): at is string => Boolean(at))
    .sort()
    .pop();

  return `The server found ${citations.length > 1 ? 'them' : 'it'}${
    checkedAt ? ` ${ago(checkedAt)}` : ''
  }. Whether ${citations.length > 1 ? 'they say' : 'it says'} what this claims is for the checks to judge.`;
}

/** What triage did, as the trail says it, and the dot it gets. */
const TRIAGE_TITLE: Record<string, [string, keyof typeof DOT]> = {
  AUTO_ACCEPT: ['Triage checked it and put it in use', 'code'],
  PROVISIONAL: ['Triage put it in use as provisional', 'written'],
  ESCALATE: ['Triage checked it and left it to a person', 'waiting'],
  REJECT: ['Triage checked it and refused it', 'retired'],
  CORROBORATE: [
    'Triage found a fact that says the same, and counted it there',
    'moved',
  ],
};

/** What made triage decide, after the time it did. */
const TRIGGER: Record<string, string> = {
  WRITTEN: 'when it was written',
  CITATIONS_CHECKED: 'once its citations were read',
  CODE_CHANGED: 'after the code it cites changed',
  RELATED: 'after a fact in use said the same',
  VERIFIER: 'after the verifier found evidence',
};

/**
 * One triage decision on the trail: when and why it ran, what each check
 * read in the sources and said, and why that led where it did.
 */
function triageStep(
  decided: PageEntryTriageStep,
  index: number,
  citations: ServedCitation[],
): Step {
  const [title, dot] = TRIAGE_TITLE[decided.decision] ?? [
    'Triage decided about it',
    'written',
  ];
  const sources = citations.length
    ? citations.map(citationLabel).join(', ')
    : 'what it cites';
  // A fact is written once: deciding again on WRITTEN means a later pass
  // did, because the rules triage decides by changed or a pass failed.
  const trigger =
    decided.trigger === 'WRITTEN' && index > 0
      ? 'again, under changed rules'
      : TRIGGER[decided.trigger ?? ''];
  const why = decided.reasons
    .map((reason) => REASON_LABELS[reason as KnowledgeReviewReasonEnum])
    .filter(Boolean);
  const onlyNarrative =
    decided.reasons.includes(KnowledgeReviewReasonEnum.EVIDENCE_DISPUTED) &&
    allContradicted(decided.checks);

  return {
    key: `triage-${index}`,
    dot,
    title,
    detail: (
      <span className="flex flex-col gap-1.5">
        <span>
          {DATE_TIME.format(new Date(decided.at))}
          {trigger ? `, ${trigger}` : ''}.
        </span>
        {decided.checks.length > 0 && (
          <span>
            {decided.checks.length === 2 ? 'Two models' : 'A model'} read{' '}
            {sources} against it:
          </span>
        )}
        {decided.checks.map((check, at) => {
          const verdict = CHECK_VERDICTS[check.verdict ?? 'unread'];

          return (
            <span key={at} className="flex gap-2">
              <span
                className={cn(
                  'mt-[6px] size-[6px] shrink-0 rounded-full',
                  verdict.dot,
                )}
              />
              <span>
                <span className="text-foreground/85">{verdict.label}.</span>{' '}
                {check.reason}
              </span>
            </span>
          );
        })}
        {onlyNarrative ? (
          <span>
            An issue or a comment tells of a change, often from the problem
            before it, so it cannot refuse a fact alone. A person decides.
          </span>
        ) : (
          why.length > 0 && <span>Why: {why.join('; ').toLowerCase()}.</span>
        )}
      </span>
    ),
  };
}

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
            <DialogTitle className="text-sm font-semibold">
              {KIND_TITLE[fact?.kind ?? 'FACT'] ?? 'Fact'}
            </DialogTitle>
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
      detail: citationDetail(fact),
    });
  }

  for (const [index, decided] of (fact.triage ?? []).entries()) {
    steps.push(triageStep(decided, index, citations));
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

  for (const [index, decided] of (fact.inboxItems ?? []).entries()) {
    steps.push({
      key: `decided-${index}`,
      dot: 'people',
      title: `Decided in Needs you by ${nameOf(decided.doneById) ?? 'a person'}`,
      detail: [decided.resolution, DATE.format(new Date(decided.doneAt))]
        .filter(Boolean)
        .join(' · '),
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
          {fact.status === PageEntryStatus.STANDING &&
          fact.trust !== 'PROVISIONAL'
            ? 'Why it is trusted'
            : 'Where it stands'}
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
