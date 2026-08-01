import { RiMoreLine } from '@remixicon/react';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vantikhq/ui/components/tooltip';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import { useAllUsers } from 'hooks/users';

import { useUpdatePageEntryMutation } from 'services/pages';

/**
 * One fact, and where it came from.
 *
 * Two shapes, because the two places a fact appears are asking different
 * questions. In the rail you are scanning — what does this page tell agents? —
 * so rows are quiet: one line of meta, actions only on hover. In the review
 * queue each row is a decision, so it carries its choices openly, with one of
 * them weighted as the answer people usually want.
 *
 * Provenance is on both. The first version printed a name and dropped the rest,
 * so facts read as though they had materialized, and "where did these come
 * from?" was the commonest reaction to the panel. A claim you are asked to
 * vouch for has to show who made it and when, because that is most of what you
 * have to judge it on.
 */

export type EntryRowVariant = 'review' | 'reference';

interface EntryRowProps {
  entry: PageEntryType;
  variant: EntryRowVariant;
  selected?: boolean;
  onToggle?: (id: string) => void;
  /** True once anything is selected, so the rest of the boxes come out to meet it. */
  selecting?: boolean;
}

export const EntryRow = observer((props: EntryRowProps) =>
  props.variant === 'review' ? (
    <ReviewRow {...props} />
  ) : (
    <RailRow {...props} />
  ),
);

/** A decision. Reads as one, and states what each choice does. */
const ReviewRow = observer(
  ({ entry, selected = false, onToggle, selecting = false }: EntryRowProps) => {
    const { mutate: update } = useUpdatePageEntryMutation();

    const set = (status: PageEntryStatus) =>
      update({ pageEntryId: entry.id, status });

    return (
      <div
        className={cn(
          // Ruled rows rather than a stack of outlined cards. Nesting bordered
          // boxes inside a bordered dialog gave three frames around every
          // sentence and made a short list look like a form.
          'group border-b border-border last:border-0 py-3 flex gap-3 transition-colors',
          selected && 'bg-grayAlpha-100',
        )}
      >
        {onToggle && (
          <Checkbox
            checked={selected}
            className={cn(
              'mt-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
              (selected || selecting) && 'opacity-100',
            )}
            aria-label="Select this fact"
            onCheckedChange={() => onToggle(entry.id)}
          />
        )}

        <div className="flex flex-col gap-1.5 min-w-0 grow">
          <p className="whitespace-pre-wrap">{entry.content}</p>

          <Meta entry={entry} />

          <div className="flex gap-1 flex-wrap -ml-2 pt-0.5">
            <Choice
              primary
              label="Use it"
              hint="Agents asking about this page start being given this fact"
              onClick={() => set(PageEntryStatus.STANDING)}
            />
            <Choice
              label="Set aside"
              hint="Kept on the record, never given to an agent. You can undo this"
              onClick={() => set(PageEntryStatus.ARCHIVED)}
            />
            <Choice
              label="Not true"
              hint="Flags it as wrong or contradicted, and stops it being given to agents"
              onClick={() => set(PageEntryStatus.DISPUTED)}
            />
          </div>
        </div>
      </div>
    );
  },
);

/**
 * A fact in the rail: quiet by default.
 *
 * Boxed cards stacked down a 280px column read as a wall of containers rather
 * than as a list of sentences — the border was doing no work that a divider and
 * a hover state do not do more calmly.
 */
const RailRow = observer(
  ({ entry, selected = false, onToggle, selecting = false }: EntryRowProps) => (
    <div
      className={cn(
        'group flex gap-2 rounded px-2 py-1.5 -mx-2 transition-colors hover:bg-grayAlpha-100',
        selected && 'bg-grayAlpha-100',
      )}
    >
      {onToggle && (
        <Checkbox
          checked={selected}
          // Hidden until the row is under the cursor or a selection is
          // underway. A column of empty boxes made a list people mostly read
          // look like a form waiting to be filled in.
          className={cn(
            'mt-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
            (selected || selecting) && 'opacity-100',
          )}
          aria-label="Select this fact"
          onCheckedChange={() => onToggle(entry.id)}
        />
      )}

      <div className="flex flex-col gap-0.5 min-w-0 grow">
        <p className="whitespace-pre-wrap">{entry.content}</p>
        <Meta entry={entry} />
      </div>

      {/* Held open while its own menu is, or it would vanish under the cursor
          on the way to the item you were reaching for. */}
      <RowMenu entry={entry} />
    </div>
  ),
);

/**
 * Who, when, where — on one line.
 *
 * This was three stacked sentences, which gave the bookkeeping about a fact
 * more room than the fact itself. The retrieval count only earns a place when
 * it says something: nothing has ever used this, or plenty has.
 */
const Meta = observer(({ entry }: { entry: PageEntryType }) => {
  const { users } = useAllUsers();

  const author = users.find((candidate) => candidate.id === entry.sourceUserId);
  const name = author?.fullname ?? author?.username ?? 'an agent';
  const isAgent = author?.type === 'Agent';

  const bits: string[] = [name];

  if (entry.createdAt) {
    bits.push(shortAgo(entry.createdAt));
  }

  if (entry.scope) {
    bits.push(entry.scope);
  }

  if (entry.status === PageEntryStatus.STANDING) {
    bits.push(
      entry.retrievalCount === 0
        ? 'never used'
        : `used ${entry.retrievalCount}×`,
    );
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground">
      {/* Wraps rather than truncates: a clipped scope ("apps/webap…") is worse
          than a second line, because the path is the part that says where the
          fact is meant to apply. */}
      <span className="break-words">{bits.join(' · ')}</span>
      {isAgent && <Badge variant="secondary">agent</Badge>}
      {entry.verifiedAt && <Badge variant="secondary">confirmed</Badge>}
    </div>
  );
});

/**
 * Corrections to a fact already in use, behind a menu on purpose.
 *
 * Giving every in-use fact the same row of buttons as one awaiting review is
 * what made the inbox meaningless: if everything is equally actionable
 * everywhere, "waiting for you" stops being a claim about anything.
 */
const RowMenu = observer(({ entry }: { entry: PageEntryType }) => {
  const { mutate: update } = useUpdatePageEntryMutation();
  const [open, setOpen] = React.useState(false);

  const items = [
    !entry.verifiedAt && {
      label: 'Confirm',
      hint: 'Vouch for it. Confirmed facts are never retired automatically',
      run: () => update({ pageEntryId: entry.id, verified: true }),
    },
    entry.status !== PageEntryStatus.STANDING && {
      label: 'Use it',
      hint: 'Agents asking about this page start being given this fact',
      run: () =>
        update({ pageEntryId: entry.id, status: PageEntryStatus.STANDING }),
    },
    entry.status !== PageEntryStatus.ARCHIVED && {
      label: 'Stop using it',
      hint: 'Kept on the record, but no longer given to agents',
      run: () =>
        update({ pageEntryId: entry.id, status: PageEntryStatus.ARCHIVED }),
    },
    entry.status !== PageEntryStatus.DISPUTED && {
      label: 'Mark as wrong',
      hint: 'Flags it as contradicted and stops it being given to agents',
      run: () =>
        update({ pageEntryId: entry.id, status: PageEntryStatus.DISPUTED }),
    },
  ].filter(Boolean) as Array<{ label: string; hint: string; run: () => void }>;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Change this fact"
          className={cn(
            'shrink-0 h-6 px-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
            open && 'opacity-100',
          )}
        >
          <RiMoreLine size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px]">
        {items.map((item) => (
          <DropdownMenuItem key={item.label} onClick={item.run}>
            <div className="flex flex-col">
              <span>{item.label}</span>
              <span className="text-muted-foreground">{item.hint}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const Choice = observer(
  ({
    label,
    hint,
    onClick,
    primary = false,
  }: {
    label: string;
    hint: string;
    onClick: () => void;
    primary?: boolean;
  }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={primary ? 'secondary' : 'ghost'}
          size="sm"
          onClick={onClick}
        >
          {label}
        </Button>
      </TooltipTrigger>
      {/* Every choice states its consequence. Labelling them with status names
          told you what the row would be called afterwards and nothing about
          what would happen to it. */}
      <TooltipContent className="max-w-[280px]">{hint}</TooltipContent>
    </Tooltip>
  ),
);

/**
 * "3d" rather than "about 3 days ago".
 *
 * The long form is fine in a dialog and too wide for a 280px rail, where it
 * pushes the author's name onto a second line and makes a one-line fact look
 * like a paragraph.
 */
function shortAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);

  if (seconds < 60) {
    return 'just now';
  }

  const steps: Array<[number, string]> = [
    [60, 'm'],
    [3600, 'h'],
    [86400, 'd'],
    [604800, 'w'],
  ];

  let label = `${Math.floor(seconds / 60)}m`;

  for (const [size, suffix] of steps) {
    const value = Math.floor(seconds / size);
    if (value >= 1) {
      label = `${value}${suffix}`;
    }
  }

  return label;
}
