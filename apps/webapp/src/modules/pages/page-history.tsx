import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import { cn } from '@vantikhq/ui/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { useAllUsers } from 'hooks/users';

import {
  type PageRevision,
  usePageHistory,
  usePageMarkdown,
  useRevertPageMutation,
} from 'services/pages';

/**
 * What has happened to this page, and a way back.
 *
 * Agents may rewrite a page body wholesale — that is deliberate, and it is how
 * documentation stays current instead of rotting between the quarters someone
 * remembers to reread it. What made it unsafe was not the writing but the
 * silence around it: history recorded only *that* the body changed, so a
 * rewrite could not be seen and could not be undone.
 *
 * The trade being made here is explicit. An agent's edit lands immediately
 * rather than waiting for approval, because an approval queue nobody clears is
 * how pages go stale in the first place — the exact failure this is for. The
 * cost is a window in which a wrong version is live, and this view is what pays
 * for it: the change is visible afterwards, as a diff, and one click undoes it.
 */
export const PageHistory = observer(
  ({
    pageId,
    open,
    onOpenChange,
  }: {
    pageId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    const { data: revisions, isLoading } = usePageHistory(pageId, open);
    const { data: current } = usePageMarkdown(pageId, open);

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[820px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Page history</DialogTitle>
          </DialogHeader>

          {isLoading && <p className="text-muted-foreground">Loading…</p>}

          {revisions && revisions.length === 0 && (
            <p className="text-muted-foreground">
              Nothing has changed since this page was created.
            </p>
          )}

          <div className="flex flex-col">
            {revisions?.map((revision) => (
              <Revision
                key={revision.id}
                revision={revision}
                currentMarkdown={current?.descriptionMarkdown ?? ''}
                onReverted={() => onOpenChange(false)}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  },
);

const Revision = observer(
  ({
    revision,
    currentMarkdown,
    onReverted,
  }: {
    revision: PageRevision;
    currentMarkdown: string;
    onReverted: () => void;
  }) => {
    const { users } = useAllUsers();
    const [showDiff, setShowDiff] = React.useState(false);

    const { mutate: revert } = useRevertPageMutation({
      onSuccess: onReverted,
    });

    const author = users.find((candidate) => candidate.id === revision.userId);
    const name = author?.fullname ?? author?.username ?? 'someone';
    const isAgent = author?.type === 'Agent';

    return (
      <div className="group border-b border-border last:border-0 py-2 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span>{summarize(revision.changes)}</span>
          {isAgent && <Badge variant="secondary">agent</Badge>}
          <span className="text-muted-foreground">
            {name} ·{' '}
            {formatDistanceToNow(new Date(revision.createdAt), {
              addSuffix: true,
            })}
          </span>

          {/* Kept out of the way until wanted: a column of "Restore this
              version" down every row reads as an instruction rather than an
              option, on a list people mostly open to read. */}
          {revision.previousBodyMarkdown !== null && (
            <div className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDiff((shown: boolean) => !shown)}
              >
                {showDiff ? 'Hide changes' : 'See what changed'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  revert({
                    pageId: revision.pageId,
                    historyId: revision.id,
                  })
                }
              >
                Restore
              </Button>
            </div>
          )}
        </div>

        {showDiff && revision.previousBodyMarkdown !== null && (
          <Diff before={revision.previousBodyMarkdown} after={currentMarkdown} />
        )}
      </div>
    );
  },
);

/**
 * The change, line by line.
 *
 * Compared against the page as it stands now rather than against the next
 * revision along: the question someone opens history with is "what would I get
 * back if I restored this", and that is a comparison with the present.
 */
const Diff = observer(
  ({ before, after }: { before: string; after: string }) => {
    const lines = React.useMemo(() => diffLines(before, after), [before, after]);

    // Happens whenever the change has already been undone, which is exactly
    // when someone is most likely to be checking. A block of unmarked grey
    // reads as a rendering failure rather than as an answer.
    if (lines.every((line) => line.kind === 'same')) {
      return (
        <p className="text-muted-foreground">
          Identical to the page as it stands now — restoring this would change
          nothing.
        </p>
      );
    }

    return (
      <pre className="rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              line.kind === 'added' && 'bg-success-foreground',
              line.kind === 'removed' && 'bg-destructive/20 line-through',
              line.kind === 'same' && 'text-muted-foreground',
            )}
          >
            <span className="select-none mr-2">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
            </span>
            {line.value || ' '}
          </div>
        ))}
      </pre>
    );
  },
);

interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  value: string;
}

/**
 * A line diff, by longest common subsequence.
 *
 * Written out rather than pulled in: a page body is prose measured in tens of
 * lines, so the quadratic table costs nothing here, and the alternative was a
 * dependency for thirty lines of code.
 */
function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split('\n');
  const right = after.split('\n');

  // lengths[i][j] — the longest run of shared lines between the tails of each
  // side, which is what tells the walk below whether a line survived.
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array(right.length + 1).fill(0),
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        left[i] === right[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ kind: 'same', value: left[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      result.push({ kind: 'removed', value: left[i] });
      i += 1;
    } else {
      result.push({ kind: 'added', value: right[j] });
      j += 1;
    }
  }

  while (i < left.length) {
    result.push({ kind: 'removed', value: left[i] });
    i += 1;
  }

  while (j < right.length) {
    result.push({ kind: 'added', value: right[j] });
    j += 1;
  }

  return result;
}

/** The patch, in words. `{ title: { from, to } }` is not a sentence. */
function summarize(changes: Record<string, unknown>): string {
  if (changes.created) {
    return 'Created the page';
  }

  if (changes.revertedTo) {
    return 'Restored an earlier version';
  }

  if (changes.consolidated) {
    const count = (changes.consolidated as { to: number }).to;
    return `Wrote ${count} ${count === 1 ? 'note' : 'notes'} into the page`;
  }

  const parts: string[] = [];

  if (changes.title) {
    const { from, to } = changes.title as { from: string; to: string };
    parts.push(`Renamed “${from}” to “${to}”`);
  }

  if (changes.body) {
    parts.push('Edited the body');
  }

  if (changes.parentId) {
    parts.push('Moved the page');
  }

  if (changes.entryPolicy) {
    const { to } = changes.entryPolicy as { to: string };
    parts.push(`Set who may add facts to ${to.toLowerCase()}`);
  }

  return parts.length > 0 ? parts.join(' · ') : 'Changed the page';
}
