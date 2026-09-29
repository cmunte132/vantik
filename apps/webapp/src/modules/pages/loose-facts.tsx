import type { KnowledgeOverviewLoose, LooseFactGroup } from '@vantikhq/types';

import { Button } from '@vantikhq/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import {
  useLooseFactsFor,
  useMakePageForMutation,
  useMoveEntriesMutation,
} from 'services/pages';

import { useContextStore } from 'store/global-context-provider';
import { LOOSE_KEY } from 'store/page-entries/store';

import { RowMenu } from './entry-row';
import { usePageNavigation } from './navigation';
import { CARD } from './trust';

/** The statuses of a fact outside any page that the list shows. */
const FILED: string[] = [PageEntryStatus.STANDING, PageEntryStatus.PROPOSED];

const SCOPE_CHIP =
  'font-mono text-xs px-1.5 py-px rounded-[5px] bg-grayAlpha-100 truncate';

/**
 * The facts that agents wrote outside any page, on the Pages home. Each
 * group shares a scope, and the gardener says where the group belongs.
 */
export const LooseFactsCard = observer(
  ({ loose }: { loose: KnowledgeOverviewLoose }) => {
    const [showing, setShowing] = React.useState<string[] | null>(null);

    if (loose.count === 0) {
      return null;
    }

    return (
      <div className={cn(CARD, 'p-4 flex flex-col gap-3')}>
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold grow">
              Facts not on a page
            </span>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => setShowing([])}
            >
              All {loose.count}
            </button>
          </div>
          <span className="text-xs text-muted-foreground">
            In use by agents now. They move under a page when one fits.
          </span>
        </div>

        {loose.groups.map((group) => (
          <LooseGroup
            key={group.scope}
            group={group}
            onShow={() => setShowing(group.entryIds)}
          />
        ))}

        <LooseFactsDialog entryIds={showing} onClose={() => setShowing(null)} />
      </div>
    );
  },
);

const LooseGroup = observer(
  ({ group, onShow }: { group: LooseFactGroup; onShow: () => void }) => {
    const goToPage = usePageNavigation();
    const [error, setError] = React.useState<string | null>(null);
    const { mutate: move, isPending: moving } = useMoveEntriesMutation({
      onMutate: () => setError(null),
      onError: setError,
    });
    const { mutate: makePage, isPending: making } = useMakePageForMutation({
      onMutate: () => setError(null),
      onSuccess: (page) => goToPage(page.id),
      onError: setError,
    });
    const { suggestion } = group;
    const count = group.entryIds.length;

    const size = (
      <button
        type="button"
        className={cn(
          'text-muted-foreground hover:underline',
          suggestion.kind === 'NONE' && 'grow text-left',
        )}
        onClick={onShow}
      >
        {count} {count === 1 ? 'fact' : 'facts'}
      </button>
    );

    if (suggestion.kind === 'NONE') {
      return (
        <div className="flex items-center gap-2 min-w-0">
          <span className={SCOPE_CHIP}>{group.scope || 'No scope'}</span>
          {size}
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            No page fits yet
          </span>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-1.5 pb-2.5 border-b border-grayAlpha-100">
        <div className="flex items-center gap-2 min-w-0">
          <span className={SCOPE_CHIP}>{group.scope || 'No scope'}</span>
          {size}
        </div>
        <div className="flex items-center gap-2">
          {suggestion.kind === 'MAKE_PAGE' ? (
            <>
              <span className="grow text-xs leading-snug text-foreground/85">
                Enough for a page of their own:{' '}
                <span className="font-medium">{suggestion.title}</span>
              </span>
              <Button
                size="sm"
                className="shrink-0"
                disabled={making}
                onClick={() =>
                  makePage({
                    title: suggestion.title ?? group.scope,
                    entryIds: group.entryIds,
                  })
                }
              >
                Make the page
              </Button>
            </>
          ) : (
            <>
              <span className="grow text-xs leading-snug text-foreground/85">
                They fit under{' '}
                <span className="font-medium">{suggestion.title}</span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={moving}
                onClick={() =>
                  suggestion.pageId &&
                  move({
                    entryIds: group.entryIds,
                    pageId: suggestion.pageId,
                    suggested: true,
                  })
                }
              >
                Move them
              </Button>
            </>
          )}
        </div>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    );
  },
);

/**
 * On a page: the facts outside any page that the gardener says belong
 * here. Moving them files them here, and agents use them as before.
 */
export const LooseFitCard = observer(({ pageId }: { pageId: string }) => {
  const { data: groups } = useLooseFactsFor(pageId);
  const [showing, setShowing] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const { mutate: move, isPending } = useMoveEntriesMutation({
    onMutate: () => setError(null),
    onError: setError,
  });

  const entryIds = (groups ?? []).flatMap((group) => group.entryIds);

  if (entryIds.length === 0) {
    return null;
  }

  const scopes = (groups ?? []).map((group) => group.scope);
  const count = entryIds.length;

  return (
    <div className="rounded-[10px] px-3.5 py-3 flex flex-col gap-2 bg-[oklch(60%_0.13_240/0.08)] border border-[oklch(60%_0.13_240/0.25)]">
      <span className="font-semibold leading-snug">
        {count === 1
          ? 'A fact outside any page looks like it belongs here'
          : `${count} facts outside any page look like they belong here`}
      </span>
      <span className="text-xs leading-snug text-foreground/85">
        Scoped to <ScopeList scopes={scopes} />. Agents already use{' '}
        {count === 1 ? 'it' : 'them'}; moving {count === 1 ? 'it' : 'them'} only
        files {count === 1 ? 'it' : 'them'} here.
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          className="bg-background-3 rounded-md px-2.5 py-1 text-xs font-medium shadow-[0_0_0_1px_oklch(0%_0_0/0.1)] disabled:opacity-60"
          disabled={isPending}
          onClick={() => move({ entryIds, pageId, suggested: true })}
        >
          {count === 1 ? 'Move it here' : 'Move them here'}
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1 text-xs font-medium text-foreground/80"
          onClick={() => setShowing(entryIds)}
        >
          {count === 1 ? 'See it' : 'See them'}
        </button>
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <LooseFactsDialog entryIds={showing} onClose={() => setShowing(null)} />
    </div>
  );
});

/** "a", "a and b", "a, b and c", with each scope in the code font. */
function ScopeList({ scopes }: { scopes: string[] }) {
  return (
    <>
      {scopes.map((scope, index) => (
        <React.Fragment key={scope}>
          {index > 0 && (index === scopes.length - 1 ? ' and ' : ', ')}
          <span className="font-mono">{scope}</span>
        </React.Fragment>
      ))}
    </>
  );
}

/**
 * The facts outside any page, by scope. `entryIds` names the facts to show,
 * an empty list shows all of them, and null closes the dialog.
 */
export const LooseFactsDialog = observer(
  ({
    entryIds,
    onClose,
  }: {
    entryIds: string[] | null;
    onClose: () => void;
  }) => {
    const { pageEntriesStore } = useContextStore();
    const all: PageEntryType[] = pageEntriesStore
      .getEntries(LOOSE_KEY)
      .filter((entry: PageEntryType) => FILED.includes(entry.status));
    const facts = entryIds?.length
      ? all.filter((entry) => entryIds.includes(entry.id))
      : all;

    const byScope = new Map<string, PageEntryType[]>();

    for (const fact of facts) {
      const scope = fact.scope ?? 'No scope';

      byScope.set(scope, [...(byScope.get(scope) ?? []), fact]);
    }

    return (
      <Dialog
        open={entryIds !== null}
        onOpenChange={(open) => !open && onClose()}
      >
        <DialogContent className="p-0 gap-0 min-w-[min(560px,calc(100vw-32px))] sm:max-w-[560px]">
          <DialogHeader className="text-left px-5 pt-5 pb-3">
            <DialogTitle className="font-normal">
              Facts outside any page
            </DialogTitle>
            <p className="text-muted-foreground">
              Agents use them now. Move a fact to file it under the page it
              belongs on.
            </p>
          </DialogHeader>

          <div className="px-5 pb-5 flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
            {facts.length === 0 && (
              <span className="text-muted-foreground">None.</span>
            )}
            {[...byScope.entries()].map(([scope, group]) => (
              <section key={scope} className="flex flex-col gap-1.5">
                <span className={cn(SCOPE_CHIP, 'self-start')}>{scope}</span>
                {group.map((fact) => (
                  <div
                    key={fact.id}
                    className="group flex items-start gap-2 py-1 border-b border-grayAlpha-100 last:border-0"
                  >
                    <span className="grow leading-snug break-words">
                      {fact.content}
                    </span>
                    {fact.status === PageEntryStatus.PROPOSED && (
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        Waits on you
                      </span>
                    )}
                    <RowMenu entry={fact} />
                  </div>
                ))}
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  },
);
