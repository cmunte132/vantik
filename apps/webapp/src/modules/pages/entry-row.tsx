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
import { MoreLine } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import { useAllUsers } from 'hooks/users';

import { useUpdatePageEntryMutation } from 'services/pages';

/**
 * One fact, and where it came from.
 *
 * The first version printed a name and dropped everything else, so facts read
 * as though they had materialized — the commonest reaction to the panel was
 * "where did these come from?". Every entry stores who wrote it, on which
 * harness session, when, and when it was last handed to an agent; a claim you
 * are being asked to vouch for has to show that, because "an agent said so" is
 * not enough to decide on and the provenance is the only thing that is.
 *
 * Shared by both places entries appear, so the two never drift into describing
 * the same row differently: `review` is the decision surface and leads with the
 * three choices, `reference` is the read-only list of what agents are currently
 * given and keeps corrections behind a menu.
 */

export type EntryRowVariant = 'review' | 'reference';

interface EntryRowProps {
  entry: PageEntryType;
  variant: EntryRowVariant;
  selected?: boolean;
  onToggle?: (id: string) => void;
}

export const EntryRow = observer(
  ({ entry, variant, selected = false, onToggle }: EntryRowProps) => {
    const { mutate: update } = useUpdatePageEntryMutation();

    const set = (status: PageEntryStatus) =>
      update({ pageEntryId: entry.id, status });

    return (
      <div
        className={cn(
          'rounded border border-border p-3 flex gap-3',
          selected && 'bg-grayAlpha-100',
        )}
      >
        {/* Selectable wherever the caller has something to do with a
            selection — triage in the queue, folding into the page body in the
            reference list. */}
        {onToggle && (
          <Checkbox
            checked={selected}
            className="mt-1"
            aria-label="Select this fact"
            onCheckedChange={() => onToggle(entry.id)}
          />
        )}

        <div className="flex flex-col gap-2 min-w-0 grow">
          <p className="whitespace-pre-wrap">{entry.content}</p>

          <Provenance entry={entry} />

          {variant === 'review' ? (
            <div className="flex gap-1 flex-wrap">
              <Choice
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
          ) : (
            <ReferenceMenu entry={entry} />
          )}
        </div>
      </div>
    );
  },
);

/**
 * Who said it, when, and whether anything has ever used it.
 *
 * The retrieval count is here rather than beside the actions because it is
 * evidence for the decision, not a decision of its own — and because zero is
 * the case it exists to surface, it is spelled out rather than left as a digit
 * for the reader to interpret.
 */
const Provenance = observer(({ entry }: { entry: PageEntryType }) => {
  const { users } = useAllUsers();

  const author = users.find((candidate) => candidate.id === entry.sourceUserId);
  const name = author?.fullname ?? author?.username ?? 'an agent';
  const isAgent = author?.type === 'Agent';

  const when = entry.createdAt
    ? formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })
    : null;

  return (
    <div className="flex flex-col gap-1 text-muted-foreground">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span>
          {isAgent ? 'Recorded by' : 'Written by'} {name}
        </span>
        {isAgent && <Badge variant="secondary">agent</Badge>}
        {when && <span>· {when}</span>}
        {entry.verifiedAt && <Badge variant="secondary">confirmed</Badge>}
      </div>

      {entry.scope && (
        <span>
          Applies to <code>{entry.scope}</code>
        </span>
      )}

      {entry.status === PageEntryStatus.STANDING && (
        <span>
          {entry.retrievalCount === 0
            ? 'No agent has been given this yet'
            : `Given to an agent ${entry.retrievalCount} ${
                entry.retrievalCount === 1 ? 'time' : 'times'
              }`}
          {entry.lastServedAt &&
            `, last ${formatDistanceToNow(new Date(entry.lastServedAt), {
              addSuffix: true,
            })}`}
        </span>
      )}
    </div>
  );
});

/**
 * Corrections to a fact already in use.
 *
 * Behind a menu on purpose. Giving every in-use fact the same row of buttons as
 * a fact awaiting review was what made the inbox meaningless — if everything is
 * equally actionable everywhere, "waiting for you" stops being a claim about
 * anything.
 */
const ReferenceMenu = observer(({ entry }: { entry: PageEntryType }) => {
  const { mutate: update } = useUpdatePageEntryMutation();

  return (
    <div className="flex">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Change this fact">
            <MoreLine size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[280px]">
          {!entry.verifiedAt && (
            <DropdownMenuItem
              onClick={() => update({ pageEntryId: entry.id, verified: true })}
            >
              <div className="flex flex-col">
                <span>Confirm</span>
                <span className="text-muted-foreground">
                  Vouch for it. Confirmed facts are never retired automatically
                </span>
              </div>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() =>
              update({
                pageEntryId: entry.id,
                status: PageEntryStatus.ARCHIVED,
              })
            }
          >
            <div className="flex flex-col">
              <span>Stop using it</span>
              <span className="text-muted-foreground">
                Kept on the record, but no longer given to agents
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              update({
                pageEntryId: entry.id,
                status: PageEntryStatus.DISPUTED,
              })
            }
          >
            <div className="flex flex-col">
              <span>Mark as wrong</span>
              <span className="text-muted-foreground">
                Flags it as contradicted and stops it being given to agents
              </span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

const Choice = observer(
  ({
    label,
    hint,
    onClick,
  }: {
    label: string;
    hint: string;
    onClick: () => void;
  }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="secondary" size="sm" onClick={onClick}>
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
