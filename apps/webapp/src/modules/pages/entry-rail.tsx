import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@vantikhq/ui/components/tabs';
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
 * Without this the bank is a black box that agents write to and nobody trusts.
 * The design constraint that shapes everything here is that **review has to
 * scale**: a rail listing entries one per row is usable at five and abandoned
 * at fifty, and fifty is the realistic steady state for an active page. So the
 * inbox opens on facet groups — "24 from claude-opus-5 scoped
 * apps/server/prisma" — and a reviewer acts on a whole group at once. Four
 * decisions instead of thirty-eight is the difference between a surface people
 * use and one they ignore, and an ignored inbox is how the bank silently stops
 * being trustworthy.
 */
export const EntryRail = observer(({ pageId }: { pageId: string }) => {
  const { pageEntriesStore } = useContextStore();

  const proposed = pageEntriesStore.getByStatus(
    pageId,
    PageEntryStatus.PROPOSED,
  );
  const standing = pageEntriesStore.getByStatus(
    pageId,
    PageEntryStatus.STANDING,
  );
  const disputed = pageEntriesStore.getByStatus(
    pageId,
    PageEntryStatus.DISPUTED,
  );

  return (
    <div className="w-[360px] shrink-0 border-l border-border h-full flex flex-col">
      {/* Named, because "what is this column" was the first thing the rail
          failed to answer. Facts are the agent-written half of the page, and
          nothing here is served until somebody accepts it. */}
      <div className="px-3 pt-3">
        <h2>Facts</h2>
        <p className="text-muted-foreground">
          What agents have asserted about this page.
        </p>
      </div>

      <Tabs defaultValue="inbox" className="flex flex-col h-full">
        <TabsList className="mx-3 mt-3">
          <TabsTrigger value="inbox">
            Inbox
            {proposed.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {proposed.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="standing">
            Standing
            {standing.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {standing.length}
              </Badge>
            )}
          </TabsTrigger>
          {/* Only shown when there is one: a contradiction between the body and
              an entry is a signal, and a permanently empty tab teaches a
              reviewer to stop looking at it. */}
          {disputed.length > 0 && (
            <TabsTrigger value="disputed">
              Disputed
              <Badge variant="secondary" className="ml-2">
                {disputed.length}
              </Badge>
            </TabsTrigger>
          )}
        </TabsList>

        <ScrollArea className="grow px-3 pb-3">
          <TabsContent value="inbox">
            <Inbox pageId={pageId} entries={proposed} />
          </TabsContent>

          <TabsContent value="standing">
            <StandingList entries={standing} />
          </TabsContent>

          <TabsContent value="disputed">
            <EntryList entries={disputed} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
});

/** Facets first, rows on request. */
const Inbox = observer(
  ({ pageId, entries }: { pageId: string; entries: PageEntryType[] }) => {
    const { pageEntriesStore } = useContextStore();
    const [showRows, setShowRows] = React.useState(false);
    const { mutate: triage } = useBulkTriageMutation();

    const facets = pageEntriesStore.facets(pageId, PageEntryStatus.PROPOSED);

    if (entries.length === 0) {
      return (
        <p className="text-muted-foreground py-4">
          Nothing waiting. Facts agents assert land here for review before
          anything is served from them.
        </p>
      );
    }

    const groups = [
      ...Object.entries(facets.sourceUserId).map(([value, count]) => ({
        kind: 'source' as const,
        value,
        count: count as number,
      })),
      ...Object.entries(facets.scope).map(([value, count]) => ({
        kind: 'scope' as const,
        value,
        count: count as number,
      })),
    ].filter((group) => group.count > 0);

    const idsFor = (group: (typeof groups)[number]) =>
      entries
        .filter((entry) =>
          group.kind === 'source'
            ? (entry.sourceUserId ?? '') === group.value
            : (entry.scope ?? '') === group.value,
        )
        .map((entry) => entry.id);

    return (
      <div className="flex flex-col gap-3 py-3">
        <p className="text-muted-foreground">
          {entries.length} proposed. Accepting serves the fact to every agent in
          the workspace; archiving keeps it readable but stops serving it.
        </p>

        {groups.map((group) => (
          <div
            key={`${group.kind}:${group.value}`}
            className="rounded border p-2 flex flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{group.count}</Badge>
              <span className="truncate">
                {group.kind === 'source' ? (
                  <SourceName userId={group.value} />
                ) : (
                  <code>{group.value || 'no scope'}</code>
                )}
              </span>
            </div>

            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  triage({
                    entryIds: idsFor(group),
                    status: PageEntryStatus.STANDING,
                  })
                }
              >
                Accept all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  triage({
                    entryIds: idsFor(group),
                    status: PageEntryStatus.ARCHIVED,
                  })
                }
              >
                Archive all
              </Button>
            </div>
          </div>
        ))}

        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setShowRows((shown) => !shown)}
        >
          {showRows ? 'Hide individual entries' : 'Review one at a time'}
        </Button>

        {showRows && <EntryList entries={entries} />}
      </div>
    );
  },
);

const StandingList = observer(
  ({ entries }: { entries: PageEntryType[] }) => {
    if (entries.length === 0) {
      return (
        <p className="text-muted-foreground py-4">
          Nothing is being served from this page yet.
        </p>
      );
    }

    return (
      <div className="flex flex-col gap-2 py-3">
        <p className="text-muted-foreground">
          Served to agents on recall. The retrieval count is how often each has
          actually been read — a standing fact at zero is dead knowledge.
        </p>
        <EntryList entries={entries} />
      </div>
    );
  },
);

const EntryList = observer(({ entries }: { entries: PageEntryType[] }) => (
  <div className="flex flex-col gap-2">
    {entries.map((entry) => (
      <EntryRow key={entry.id} entry={entry} />
    ))}
  </div>
));

const EntryRow = observer(({ entry }: { entry: PageEntryType }) => {
  const { mutate: update } = useUpdatePageEntryMutation();

  return (
    <div className="rounded border p-2 flex flex-col gap-2">
      <p className="whitespace-pre-wrap">{entry.content}</p>

      <div className="flex items-center gap-2 flex-wrap text-muted-foreground">
        <SourceName userId={entry.sourceUserId ?? ''} />
        {entry.scope && <code className="truncate">{entry.scope}</code>}
        {entry.status === PageEntryStatus.STANDING && (
          <span
            className={cn(entry.retrievalCount === 0 && 'text-muted-foreground')}
          >
            served {entry.retrievalCount}×
          </span>
        )}
        {entry.verifiedAt && <Badge variant="secondary">verified</Badge>}
      </div>

      <div className="flex gap-2 flex-wrap">
        {entry.status === PageEntryStatus.PROPOSED && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              update({
                pageEntryId: entry.id,
                status: PageEntryStatus.STANDING,
              })
            }
          >
            Accept
          </Button>
        )}
        {entry.status !== PageEntryStatus.DISPUTED && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              update({
                pageEntryId: entry.id,
                status: PageEntryStatus.DISPUTED,
              })
            }
          >
            Dispute
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            update({ pageEntryId: entry.id, status: PageEntryStatus.ARCHIVED })
          }
        >
          Archive
        </Button>
        {!entry.verifiedAt && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => update({ pageEntryId: entry.id, verified: true })}
          >
            Verify
          </Button>
        )}
      </div>
    </div>
  );
});

/**
 * Who asserted a fact, badged when it was an agent.
 *
 * An agent-written claim and a human-written one are identical as text, and the
 * difference is the entire reason a reviewer is looking at this list.
 */
const SourceName = observer(({ userId }: { userId: string }) => {
  const currentUser = React.useContext(UserContext);
  // The workspace store holds memberships, which carry a role but no name —
  // the account itself is what has a name and a type, which is what actually
  // distinguishes an agent's claim from a person's.
  const { users } = useAllUsers();

  if (!userId) {
    return <span className="text-muted-foreground">unknown source</span>;
  }

  const user = users.find((candidate) => candidate.id === userId);
  const name = user?.fullname ?? user?.username ?? userId.slice(0, 8);
  const isAgent = user?.type === 'Agent';

  return (
    <span className="flex items-center gap-1">
      {name}
      {userId === currentUser?.id && <span>(you)</span>}
      {isAgent && <Badge variant="secondary">agent</Badge>}
    </span>
  );
});
