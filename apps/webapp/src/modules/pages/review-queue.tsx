import type { KnowledgeReviewReasonEnum } from '@vantikhq/types';

import { Button } from '@vantikhq/ui/components/button';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import {
  useBulkTriageMutation,
  useKnowledgeReview,
  useResolveAuditMutation,
  useResolveProposalMutation,
} from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { EntryRow } from './entry-row';
import {
  auditPrompt,
  proposalPrompt,
  REASON_LABELS,
  reasonFacets,
  reviewRows,
  withReason,
  type ReviewRow,
} from './review-reasons';

/**
 * The queue of facts waiting on a decision.
 *
 * One component, scoped two ways: to a page (opened from the page you are
 * reading, when you want to clear just its queue) or to the whole workspace
 * (the inbox you sit down to, the way you clear mail). They are the same
 * pipeline, so they are the same code — the scope only changes which entries
 * come in and whether rows are grouped under the page they belong to.
 *
 * This exists as its own surface because reviewing and writing are different
 * jobs. Reviewing is episodic and has a finish line; writing a page is neither.
 * Sitting the queue permanently beside the editor made the editor look like it
 * was asking you to moderate, and made the queue look like a filter over a list
 * rather than a thing you complete.
 */

export type ReviewScope =
  { kind: 'page'; pageId: string } | { kind: 'workspace' };

/**
 * With triage on, each waiting fact says why it was held back, and beside
 * them sit a sample of what triage did alone, drawn for a person to check.
 * The reasons and the audits come from the server; the facts themselves from
 * the synced store, so the queue stays live and, with triage off or the
 * server not answering, is exactly the inbox it always was.
 */
export const ReviewQueue = observer(({ scope }: { scope: ReviewScope }) => {
  const { pageEntriesStore } = useContextStore();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [reason, setReason] = React.useState<KnowledgeReviewReasonEnum | null>(
    null,
  );
  const pageId = scope.kind === 'page' ? scope.pageId : undefined;
  const { data: review } = useKnowledgeReview(pageId);

  const waiting: PageEntryType[] =
    scope.kind === 'page'
      ? pageEntriesStore.getByStatus(scope.pageId, PageEntryStatus.PROPOSED)
      : pageEntriesStore.getAllByStatus(PageEntryStatus.PROPOSED);

  const all = reviewRows(waiting, review, (entryId, pageId) =>
    pageEntriesStore
      .getEntries(pageId)
      .find((entry: PageEntryType) => entry.id === entryId),
  );
  const facets = reasonFacets(all);
  // A reason whose last row was just resolved stops narrowing the queue,
  // rather than leaving the reviewer looking at nothing.
  const chosen = facets.some((facet) => facet.reason === reason)
    ? reason
    : null;
  const rows = withReason(all, chosen);

  // Dropped when the scope changes, so a bulk action can never land on rows the
  // reviewer is no longer looking at.
  React.useEffect(() => {
    setSelected(new Set());
    setReason(null);
  }, [scope.kind, pageId]);

  const toggle = (id: string) =>
    setSelected((current: Set<string>) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const selectMany = (ids: string[], select: boolean) =>
    setSelected((current: Set<string>) => {
      const next = new Set(current);
      ids.forEach((id) => (select ? next.add(id) : next.delete(id)));
      return next;
    });

  if (all.length === 0) {
    return <EmptyQueue scope={scope} />;
  }

  return (
    <div className="flex flex-col gap-4 h-full">
      {facets.length > 0 && (
        <ReasonFilter facets={facets} chosen={chosen} onChoose={setReason} />
      )}

      <div className="grow flex flex-col gap-4 min-h-0">
        {scope.kind === 'workspace' ? (
          <ByPage
            rows={rows}
            selected={selected}
            onToggle={toggle}
            onSelectMany={selectMany}
          />
        ) : (
          <div className="flex flex-col">
            {rows.map((row) => (
              <QueueRow
                key={rowKey(row)}
                row={row}
                selected={selected}
                onToggle={toggle}
              />
            ))}
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <BulkBar ids={[...selected]} onDone={() => setSelected(new Set())} />
      )}
    </div>
  );
});

/**
 * Nothing waiting — said as an explanation of the mechanism rather than a
 * shrug, because an empty queue is the most likely first sight of this feature
 * and "no items" teaches nobody where items would have come from.
 */
const EmptyQueue = observer(({ scope }: { scope: ReviewScope }) => (
  <div className="flex flex-col gap-2 py-2">
    <p>Nothing waiting for you.</p>
    <p className="text-muted-foreground">
      When an agent learns something durable while working — a decision, a
      constraint, a gotcha — it records it as a short fact
      {scope.kind === 'page' ? ' on this page' : ' on the relevant page'}. Facts
      land here first and are given to no agent until you decide.
    </p>
  </div>
));

/**
 * Narrows the queue to one reason, with how many rows carry each, so a
 * reviewer can clear everything that cites nothing in one sitting and every
 * contradiction in another: each asks for a different kind of reading.
 */
const ReasonFilter = observer(
  ({
    facets,
    chosen,
    onChoose,
  }: {
    facets: ReturnType<typeof reasonFacets>;
    chosen: KnowledgeReviewReasonEnum | null;
    onChoose: (reason: KnowledgeReviewReasonEnum | null) => void;
  }) => (
    <div className="flex gap-1 flex-wrap -ml-2">
      <Button
        variant={chosen === null ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => onChoose(null)}
      >
        All
      </Button>
      {facets.map((facet) => (
        <Button
          key={facet.reason}
          variant={chosen === facet.reason ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onChoose(facet.reason)}
        >
          {facet.label}
          <span className="text-muted-foreground ml-1">{facet.count}</span>
        </Button>
      ))}
    </div>
  ),
);

/**
 * One row: a waiting fact with its choices, or an audit or a proposal with
 * its question. Either is answered on its own, never in bulk: an audit asks
 * whether triage was right about that one fact, a proposal whether the
 * change the gardener found means that one fact should go.
 */
const QueueRow = observer(
  ({
    row,
    selected,
    onToggle,
  }: {
    row: ReviewRow;
    selected: Set<string>;
    onToggle: (id: string) => void;
  }) => {
    const { mutate: answer } = useResolveAuditMutation();
    const { mutate: answerProposal } = useResolveProposalMutation();
    const { audit, proposal } = row;
    const question = audit
      ? {
          ...auditPrompt(audit),
          onAnswer: (agree: boolean) =>
            answer({ decisionId: audit.decisionId, agree }),
        }
      : proposal
        ? {
            ...proposalPrompt(proposal),
            onAnswer: (accept: boolean) =>
              answerProposal({ proposalId: proposal.id, accept }),
          }
        : undefined;

    return (
      <EntryRow
        entry={row.entry}
        variant="review"
        reasons={row.reasons.map((reason) => REASON_LABELS[reason])}
        audit={question}
        selected={!question && selected.has(row.entry.id)}
        selecting={selected.size > 0}
        onToggle={question ? undefined : onToggle}
      />
    );
  },
);

function rowKey(row: ReviewRow): string {
  return row.audit
    ? `audit:${row.audit.decisionId}`
    : row.proposal
      ? `proposal:${row.proposal.id}`
      : row.entry.id;
}

/**
 * Workspace review, grouped under the page each fact belongs to.
 *
 * A claim is only judgeable against what its page is for — "we deploy with
 * podman" means one thing on a runbook and another on a page about local
 * setup — so the page is a heading here rather than a field on the row.
 */
const ByPage = observer(
  ({
    rows,
    selected,
    onToggle,
    onSelectMany,
  }: {
    rows: ReviewRow[];
    selected: Set<string>;
    onToggle: (id: string) => void;
    onSelectMany: (ids: string[], select: boolean) => void;
  }) => {
    const { pagesStore } = useContextStore();

    const groups = new Map<string, ReviewRow[]>();
    for (const row of rows) {
      const { pageId } = row.entry;
      groups.set(pageId, [...(groups.get(pageId) ?? []), row]);
    }

    return (
      <div className="flex flex-col gap-6">
        {[...groups.entries()].map(([pageId, group]) => {
          const page = pagesStore.getPageWithId(pageId);
          // Selecting a page selects what can be decided in bulk: its
          // waiting facts, not its audits or proposals.
          const ids = group
            .filter((row) => !row.audit && !row.proposal)
            .map((row) => row.entry.id);
          const allSelected =
            ids.length > 0 && ids.every((id) => selected.has(id));

          return (
            <section key={pageId} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {ids.length > 0 && (
                  <Checkbox
                    checked={allSelected}
                    aria-label={`Select all waiting on ${page?.title ?? 'this page'}`}
                    onCheckedChange={(checked: boolean) =>
                      onSelectMany(ids, Boolean(checked))
                    }
                  />
                )}
                <h3 className="truncate">{page?.title || 'Untitled page'}</h3>
                <span className="text-muted-foreground">
                  {group.length} waiting
                </span>
              </div>

              <div className="flex flex-col">
                {group.map((row) => (
                  <QueueRow
                    key={rowKey(row)}
                    row={row}
                    selected={selected}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  },
);

/** Appears only when something is selected, the way a mail client's does. */
const BulkBar = observer(
  ({ ids, onDone }: { ids: string[]; onDone: () => void }) => {
    const { mutate: triage } = useBulkTriageMutation({ onSuccess: onDone });

    const apply = (status: PageEntryStatus) =>
      triage({ entryIds: ids, status });

    return (
      <div className="sticky bottom-0 -mx-6 px-6 py-3 bg-background-2 border-t border-border flex items-center gap-2 flex-wrap">
        <span className="text-muted-foreground mr-1">
          {ids.length} selected
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => apply(PageEntryStatus.STANDING)}
        >
          Use {ids.length}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => apply(PageEntryStatus.ARCHIVED)}
        >
          Set aside
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    );
  },
);
