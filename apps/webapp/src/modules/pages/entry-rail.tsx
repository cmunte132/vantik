import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vantikhq/ui/components/tooltip';
import { ChevronRight } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import { useAllUsers } from 'hooks/users';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

import {
  useBulkTriageMutation,
  useUpdatePageEntryMutation,
} from 'services/pages';

/**
 * The review surface: what agents have asserted about this page, and what to do
 * about it.
 *
 * Built as a moderation queue, because that is a shape people already know.
 * The first version was not one, and four things were wrong with it:
 *
 * 1. **The same entry appeared twice.** It grouped by source *and* by scope at
 *    once, so a single entry showed as "1 claude-opus-5" and again as
 *    "1 apps/server" — a panel that says two when it means one.
 * 2. **The vocabulary was the database's.** "Standing", "Proposed" and
 *    "Disputed" are enum values; nobody had been told that "Standing" means
 *    agents are being handed this right now. The API keeps those names, this
 *    does not.
 * 3. **No action said what it did.** Accept into what? Is archive a delete?
 *    What is verify *for*, once a thing is already accepted?
 * 4. **You acted on groups you could not see inside.** Accepting claims
 *    sight-unseen is precisely the wrong default on a surface whose entire
 *    purpose is deciding what to trust.
 *
 * So: rows are always visible, selection is by checkbox with a bulk bar, and
 * grouping is a control that changes how rows are *arranged* rather than a
 * substitute for showing them. That keeps the "four decisions, not thirty-eight"
 * property — select a group, act once — without asking anyone to sign off on
 * text they have not read.
 */

type Tab = 'inbox' | 'in-use' | 'set-aside';
type GroupBy = 'source' | 'scope' | 'none';

const TABS: Array<{ id: Tab; label: string; status: PageEntryStatus }> = [
  { id: 'inbox', label: 'Inbox', status: PageEntryStatus.PROPOSED },
  { id: 'in-use', label: 'In use', status: PageEntryStatus.STANDING },
  { id: 'set-aside', label: 'Set aside', status: PageEntryStatus.ARCHIVED },
];

/** What each tab is, said once, at the top, in consequences. */
const TAB_HELP: Record<Tab, string> = {
  inbox:
    'Claims agents have made, waiting on you. Nothing here is given to any agent until you accept it.',
  'in-use':
    'Agents are given these when they ask about this page. Confirmed ones are never retired automatically.',
  'set-aside':
    'Kept for the record but never given to agents. Nothing here is deleted — you can put any of it back in use.',
};

export const EntryRail = observer(({ pageId }: { pageId: string }) => {
  const { pageEntriesStore } = useContextStore();
  const [tab, setTab] = React.useState<Tab>('inbox');
  const [groupBy, setGroupBy] = React.useState<GroupBy>('source');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const countFor = (status: PageEntryStatus) =>
    pageEntriesStore.getByStatus(pageId, status).length;

  const active = TABS.find((candidate) => candidate.id === tab);
  const entries: PageEntryType[] = pageEntriesStore.getByStatus(
    pageId,
    active.status,
  );

  const flagged: PageEntryType[] = pageEntriesStore.getByStatus(
    pageId,
    PageEntryStatus.DISPUTED,
  );

  // Selection is per tab: carrying it across would let a bulk action land on
  // rows the person can no longer see.
  React.useEffect(() => setSelected(new Set()), [tab, pageId]);

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

  return (
    <div className="w-[400px] shrink-0 border-l border-border h-full flex flex-col">
      <div className="px-3 pt-3 flex flex-col gap-2">
        <div>
          <h2>Facts from agents</h2>
          <p className="text-muted-foreground">
            Short claims agents recorded here. The page body is what your team
            wrote.
          </p>
        </div>

        <div className="flex items-center gap-1">
          {TABS.map((candidate) => (
            <Button
              key={candidate.id}
              variant={tab === candidate.id ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTab(candidate.id)}
            >
              {candidate.label}
              {countFor(candidate.status) > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {countFor(candidate.status)}
                </Badge>
              )}
            </Button>
          ))}
        </div>

        <p className="text-muted-foreground">{TAB_HELP[tab]}</p>

        {/* A flagged entry is a contradiction somewhere in the bank, so it is
            surfaced from every tab rather than hidden behind one. */}
        {flagged.length > 0 && tab !== 'inbox' && (
          <FlaggedBanner count={flagged.length} />
        )}
      </div>

      {entries.length > 0 && (
        <div className="px-3 pt-2 flex items-center gap-2">
          <span className="text-muted-foreground">Group by</span>
          <Select
            value={groupBy}
            onValueChange={(value: GroupBy) => setGroupBy(value)}
          >
            <SelectTrigger className="h-7 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="source">Who said it</SelectItem>
              <SelectItem value="scope">Where it applies</SelectItem>
              <SelectItem value="none">Nothing</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <ScrollArea className="grow px-3 pb-3 pt-2">
        <EntryGroups
          entries={entries}
          groupBy={groupBy}
          selected={selected}
          onToggle={toggle}
          onSelectMany={selectMany}
          emptyMessage={
            tab === 'inbox'
              ? 'Nothing waiting. New claims from agents land here first.'
              : tab === 'in-use'
                ? 'No facts are being given to agents from this page yet.'
                : 'Nothing has been set aside.'
          }
        />
      </ScrollArea>

      {selected.size > 0 && (
        <BulkBar
          tab={tab}
          ids={[...selected]}
          onDone={() => setSelected(new Set())}
        />
      )}
    </div>
  );
});

const FlaggedBanner = observer(({ count }: { count: number }) => (
  <p className="rounded border border-border px-2 py-1 text-muted-foreground">
    {count} {count === 1 ? 'fact is' : 'facts are'} flagged as wrong and not
    being given to agents.
  </p>
));

interface GroupsProps {
  entries: PageEntryType[];
  groupBy: GroupBy;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectMany: (ids: string[], select: boolean) => void;
  emptyMessage: string;
}

/**
 * Rows, arranged.
 *
 * Grouping picks **one** axis, so every entry is listed exactly once — the
 * previous version summed two axes and double-counted everything in the panel.
 */
const EntryGroups = observer(
  ({
    entries,
    groupBy,
    selected,
    onToggle,
    onSelectMany,
    emptyMessage,
  }: GroupsProps) => {
    const { users } = useAllUsers();

    if (entries.length === 0) {
      return <p className="text-muted-foreground py-2">{emptyMessage}</p>;
    }

    if (groupBy === 'none') {
      return (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              selected={selected.has(entry.id)}
              onToggle={onToggle}
            />
          ))}
        </div>
      );
    }

    const keyOf = (entry: PageEntryType) =>
      groupBy === 'source' ? (entry.sourceUserId ?? '') : (entry.scope ?? '');

    const groups = new Map<string, PageEntryType[]>();
    for (const entry of entries) {
      const key = keyOf(entry);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }

    const labelOf = (key: string) => {
      if (groupBy === 'scope') {
        return key || 'Everywhere on this page';
      }
      const user = users.find((candidate) => candidate.id === key);
      return user?.fullname ?? user?.username ?? 'Unknown source';
    };

    return (
      <div className="flex flex-col gap-3">
        {[...groups.entries()].map(([key, rows]) => (
          <EntryGroup
            key={key || 'ungrouped'}
            label={labelOf(key)}
            isAgent={
              groupBy === 'source' &&
              users.find((candidate) => candidate.id === key)?.type === 'Agent'
            }
            isCode={groupBy === 'scope' && Boolean(key)}
            rows={rows}
            selected={selected}
            onToggle={onToggle}
            onSelectMany={onSelectMany}
          />
        ))}
      </div>
    );
  },
);

const EntryGroup = observer(
  ({
    label,
    isAgent,
    isCode,
    rows,
    selected,
    onToggle,
    onSelectMany,
  }: {
    label: string;
    isAgent: boolean;
    isCode: boolean;
    rows: PageEntryType[];
    selected: Set<string>;
    onToggle: (id: string) => void;
    onSelectMany: (ids: string[], select: boolean) => void;
  }) => {
    const [open, setOpen] = React.useState(true);
    const ids = rows.map((row) => row.id);
    const allSelected = ids.every((id) => selected.has(id));

    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Checkbox
            checked={allSelected}
            aria-label={`Select all from ${label}`}
            onCheckedChange={(checked: boolean) =>
              onSelectMany(ids, Boolean(checked))
            }
          />

          <button
            type="button"
            className="flex items-center gap-1 grow min-w-0 text-left"
            onClick={() => setOpen((shown: boolean) => !shown)}
          >
            <ChevronRight
              size={12}
              className={cn(
                'shrink-0 transition-transform',
                open && 'rotate-90',
              )}
            />
            {isCode ? (
              <code className="truncate">{label}</code>
            ) : (
              <span className="truncate">{label}</span>
            )}
            {isAgent && <Badge variant="secondary">agent</Badge>}
            <Badge variant="secondary" className="ml-auto">
              {rows.length}
            </Badge>
          </button>
        </div>

        {open && (
          <div className="flex flex-col gap-2 pl-6">
            {rows.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                selected={selected.has(entry.id)}
                onToggle={onToggle}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);

const EntryRow = observer(
  ({
    entry,
    selected,
    onToggle,
  }: {
    entry: PageEntryType;
    selected: boolean;
    onToggle: (id: string) => void;
  }) => {
    const { mutate: update } = useUpdatePageEntryMutation();
    const { users } = useAllUsers();
    const currentUser = React.useContext(UserContext);

    const author = users.find(
      (candidate) => candidate.id === entry.sourceUserId,
    );
    const name = author?.fullname ?? author?.username ?? 'unknown';

    return (
      <div
        className={cn(
          'rounded border border-border p-2 flex gap-2',
          selected && 'bg-grayAlpha-100',
        )}
      >
        <Checkbox
          checked={selected}
          className="mt-0.5"
          aria-label="Select this fact"
          onCheckedChange={() => onToggle(entry.id)}
        />

        <div className="flex flex-col gap-1.5 min-w-0 grow">
          <p className="whitespace-pre-wrap">{entry.content}</p>

          <div className="flex items-center gap-2 flex-wrap text-muted-foreground">
            <span>
              {name}
              {entry.sourceUserId === currentUser?.id && ' (you)'}
            </span>
            {author?.type === 'Agent' && (
              <Badge variant="secondary">agent</Badge>
            )}
            {entry.scope && <code className="truncate">{entry.scope}</code>}
            {entry.verifiedAt && <Badge variant="secondary">confirmed</Badge>}
          </div>

          {entry.status === PageEntryStatus.STANDING && (
            <RetrievalCount count={entry.retrievalCount} />
          )}

          <div className="flex gap-1 flex-wrap">
            <RowAction
              show={entry.status !== PageEntryStatus.STANDING}
              label="Use"
              hint="Start giving this to agents that ask about this page"
              onClick={() =>
                update({
                  pageEntryId: entry.id,
                  status: PageEntryStatus.STANDING,
                })
              }
            />
            <RowAction
              show={
                entry.status === PageEntryStatus.STANDING && !entry.verifiedAt
              }
              label="Confirm"
              hint="Vouch for this. Confirmed facts are never retired automatically"
              onClick={() => update({ pageEntryId: entry.id, verified: true })}
            />
            <RowAction
              show={entry.status !== PageEntryStatus.DISPUTED}
              label="Flag"
              hint="Mark as wrong or contradicted. Stops being given to agents"
              onClick={() =>
                update({
                  pageEntryId: entry.id,
                  status: PageEntryStatus.DISPUTED,
                })
              }
            />
            <RowAction
              show={entry.status !== PageEntryStatus.ARCHIVED}
              label="Set aside"
              hint="Keep it, but stop giving it to agents. Reversible"
              onClick={() =>
                update({
                  pageEntryId: entry.id,
                  status: PageEntryStatus.ARCHIVED,
                })
              }
            />
          </div>
        </div>
      </div>
    );
  },
);

/**
 * How often a fact has actually been given to an agent.
 *
 * "served 4×" meant nothing to anyone who had not read the schema. What the
 * number is *for* is spotting knowledge nothing uses, so zero says so outright
 * rather than leaving the reader to infer it from a count.
 */
const RetrievalCount = observer(({ count }: { count: number }) => (
  <span className="text-muted-foreground">
    {count === 0
      ? 'Never used by an agent yet'
      : `Given to an agent ${count} ${count === 1 ? 'time' : 'times'}`}
  </span>
));

const RowAction = observer(
  ({
    show,
    label,
    hint,
    onClick,
  }: {
    show: boolean;
    label: string;
    hint: string;
    onClick: () => void;
  }) => {
    if (!show) {
      return null;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" onClick={onClick}>
            {label}
          </Button>
        </TooltipTrigger>
        {/* Every action states its consequence. The first version labelled them
            with status names, which told you what the row would be called
            afterwards and nothing about what would happen. */}
        <TooltipContent className="max-w-[260px]">{hint}</TooltipContent>
      </Tooltip>
    );
  },
);

/** Appears only when something is selected, the way a mail client's does. */
const BulkBar = observer(
  ({ tab, ids, onDone }: { tab: Tab; ids: string[]; onDone: () => void }) => {
    const { mutate: triage } = useBulkTriageMutation({ onSuccess: onDone });

    const apply = (status: PageEntryStatus) => triage({ entryIds: ids, status });

    return (
      <div className="border-t border-border p-3 flex flex-col gap-2">
        <span className="text-muted-foreground">{ids.length} selected</span>
        <div className="flex gap-2 flex-wrap">
          {tab !== 'in-use' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => apply(PageEntryStatus.STANDING)}
            >
              Use {ids.length}
            </Button>
          )}
          {tab !== 'set-aside' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => apply(PageEntryStatus.ARCHIVED)}
            >
              Set aside
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    );
  },
);
