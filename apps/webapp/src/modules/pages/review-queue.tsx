import { Button } from '@vantikhq/ui/components/button';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

import { useBulkTriageMutation } from 'services/pages';

import { EntryRow } from './entry-row';

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
  | { kind: 'page'; pageId: string }
  | { kind: 'workspace' };

export const ReviewQueue = observer(({ scope }: { scope: ReviewScope }) => {
  const { pageEntriesStore } = useContextStore();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const entries: PageEntryType[] =
    scope.kind === 'page'
      ? pageEntriesStore.getByStatus(scope.pageId, PageEntryStatus.PROPOSED)
      : pageEntriesStore.getAllByStatus(PageEntryStatus.PROPOSED);

  // Dropped when the scope changes, so a bulk action can never land on rows the
  // reviewer is no longer looking at.
  React.useEffect(
    () => setSelected(new Set()),
    [scope.kind, scope.kind === 'page' ? scope.pageId : ''],
  );

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

  if (entries.length === 0) {
    return <EmptyQueue scope={scope} />;
  }

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="grow flex flex-col gap-4 min-h-0">
        {scope.kind === 'workspace' ? (
          <ByPage
            entries={entries}
            selected={selected}
            onToggle={toggle}
            onSelectMany={selectMany}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                variant="review"
                selected={selected.has(entry.id)}
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
 * Workspace review, grouped under the page each fact belongs to.
 *
 * A claim is only judgeable against what its page is for — "we deploy with
 * podman" means one thing on a runbook and another on a page about local
 * setup — so the page is a heading here rather than a field on the row.
 */
const ByPage = observer(
  ({
    entries,
    selected,
    onToggle,
    onSelectMany,
  }: {
    entries: PageEntryType[];
    selected: Set<string>;
    onToggle: (id: string) => void;
    onSelectMany: (ids: string[], select: boolean) => void;
  }) => {
    const { pagesStore } = useContextStore();

    const groups = new Map<string, PageEntryType[]>();
    for (const entry of entries) {
      groups.set(entry.pageId, [...(groups.get(entry.pageId) ?? []), entry]);
    }

    return (
      <div className="flex flex-col gap-6">
        {[...groups.entries()].map(([pageId, rows]) => {
          const page = pagesStore.getPageWithId(pageId);
          const ids = rows.map((row) => row.id);
          const allSelected = ids.every((id) => selected.has(id));

          return (
            <section key={pageId} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={allSelected}
                  aria-label={`Select all waiting on ${page?.title ?? 'this page'}`}
                  onCheckedChange={(checked: boolean) =>
                    onSelectMany(ids, Boolean(checked))
                  }
                />
                <h3 className="truncate">{page?.title || 'Untitled page'}</h3>
                <span className="text-muted-foreground">
                  {rows.length} waiting
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {rows.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    variant="review"
                    selected={selected.has(entry.id)}
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

    const apply = (status: PageEntryStatus) => triage({ entryIds: ids, status });

    return (
      <div className="sticky bottom-0 bg-background-2 border-t border-border pt-3 flex items-center gap-2 flex-wrap">
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
