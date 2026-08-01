import {
  RiAddLine,
  RiArrowRightSLine,
  RiSidebarFoldLine,
  RiSidebarUnfoldLine,
} from '@remixicon/react';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { Textarea } from '@vantikhq/ui/components/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vantikhq/ui/components/tooltip';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import { useLocalCommonState } from 'hooks/use-local-state';

import { useCreatePageEntryMutation } from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { ConsolidateDialog } from './consolidate-dialog';
import { EntryRow } from './entry-row';
import { ReviewQueue } from './review-queue';

/**
 * What this page tells agents, in the rail beside it.
 *
 * It began as a moderation queue here, moved to the foot of the page when that
 * proved incomprehensible, and came back — because the queue was the problem,
 * not the position. The foot of a document is where human conversation belongs;
 * standing metadata about the page belongs beside it, which is where this
 * product already keeps an issue's properties.
 *
 * What is here now is a summary and a way in, not a workbench. Deciding happens
 * in {@link ReviewQueue}, on its own surface. Reading what agents are given
 * stays, because "what does this page actually tell an agent" is a fair
 * question while you are editing it — but it is read-only, quiet, and folded
 * away until asked for.
 */
export const MemoryRail = observer(({ pageId }: { pageId: string }) => {
  const { pageEntriesStore } = useContextStore();

  // Collapsed until asked for, and the choice sticks across pages — a rail you
  // have to close on every document is worse than one that was never there.
  // Deliberately not keyed by page: this is a preference about how you read,
  // not a property of the page you happen to be on.
  const [open, setOpen] = useLocalCommonState<boolean>('pageMemoryRail', false);

  const [reviewing, setReviewing] = React.useState(false);
  const [showStanding, setShowStanding] = React.useState(false);
  const [showSetAside, setShowSetAside] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [folding, setFolding] = React.useState<PageEntryType[]>([]);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());

  const byStatus = (status: PageEntryStatus): PageEntryType[] =>
    pageEntriesStore.getByStatus(pageId, status);

  const standing = byStatus(PageEntryStatus.STANDING);
  const waiting = byStatus(PageEntryStatus.PROPOSED);
  const setAside = [
    ...byStatus(PageEntryStatus.ARCHIVED),
    ...byStatus(PageEntryStatus.DISPUTED),
  ];

  const toggle = (id: string) =>
    setPicked((current: Set<string>) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  if (!open) {
    return (
      <div className="shrink-0 border-l border-border flex flex-col items-center gap-2 w-[44px] h-full pt-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="px-2"
              aria-label="Show agent memory"
              onClick={() => setOpen(true)}
            >
              <RiSidebarFoldLine size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Agent memory</TooltipContent>
        </Tooltip>

        {/* The one thing that must survive collapsing. Closed by default means
            nobody is looking, so a queue with no outward sign of being there
            is a queue that never gets cleared. */}
        {waiting.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${waiting.length} facts waiting for review`}
                onClick={() => setOpen(true)}
              >
                <Badge variant="secondary">{waiting.length}</Badge>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {waiting.length} waiting for you
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-l border-border flex flex-col w-[360px] h-full">
      <ScrollArea className="h-full">
        <div className="p-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h3 className="grow">Agent memory</h3>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-2 -mr-1"
                    aria-label="Hide agent memory"
                    onClick={() => setOpen(false)}
                  >
                    <RiSidebarUnfoldLine size={16} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">Hide</TooltipContent>
              </Tooltip>
            </div>
            <p className="text-muted-foreground">
              Short facts agents recorded here as they worked. They are given
              these along with the page itself — they are not part of it.
            </p>
          </div>

          {waiting.length > 0 && (
            <button
              type="button"
              className="rounded-md border border-border p-2 text-left flex flex-col gap-1 hover:bg-grayAlpha-100 transition-colors"
              onClick={() => setReviewing(true)}
            >
              <span>{waiting.length} waiting for you</span>
              <span className="text-muted-foreground">
                No agent is given {waiting.length === 1 ? 'it' : 'them'} until
                you decide. Review →
              </span>
            </button>
          )}

          <Section
            label="In use"
            count={standing.length}
            open={showStanding}
            onToggle={() => setShowStanding((shown: boolean) => !shown)}
            empty="Nothing yet"
          >
            <p className="text-muted-foreground mb-1">
              Pick any that have earned a place in the page itself.
            </p>

            {standing.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                variant="reference"
                selected={picked.has(entry.id)}
                selecting={picked.size > 0}
                onToggle={toggle}
              />
            ))}

            {picked.size > 0 && (
              <div className="flex items-center gap-1 pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setFolding(standing.filter((entry) => picked.has(entry.id)))
                  }
                >
                  Write {picked.size} into the page
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPicked(new Set())}
                >
                  Cancel
                </Button>
              </div>
            )}
          </Section>

          {setAside.length > 0 && (
            <Section
              label="Set aside"
              count={setAside.length}
              open={showSetAside}
              onToggle={() => setShowSetAside((shown: boolean) => !shown)}
            >
              <p className="text-muted-foreground mb-1">
                Kept on the record, never given to an agent.
              </p>

              {setAside.map((entry) => (
                <EntryRow key={entry.id} entry={entry} variant="reference" />
              ))}
            </Section>
          )}

          {adding ? (
            <AddFact pageId={pageId} onDone={() => setAdding(false)} />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 self-start px-1"
              onClick={() => setAdding(true)}
            >
              <RiAddLine size={14} />
              Add a fact
            </Button>
          )}
        </div>
      </ScrollArea>

      <Dialog open={reviewing} onOpenChange={setReviewing}>
        {/* The primitive pins itself to 500px with an `!important` max-width
            and ships no padding of its own, so width has to be driven by
            min-w and the spacing supplied here — the same way the member and
            project dialogs do it. */}
        <DialogContent className="p-0 gap-0 min-w-[720px] sm:max-w-[720px]">
          <DialogHeader className="text-left px-6 pt-6 pb-4 border-b border-border">
            <DialogTitle className="font-normal">
              Facts waiting on this page
            </DialogTitle>
            <p className="text-muted-foreground">
              Recorded by agents as they worked. None of it is given to an agent
              until you decide.
            </p>
          </DialogHeader>

          <div className="px-6 py-4 overflow-y-auto max-h-[60vh]">
            <ReviewQueue scope={{ kind: 'page', pageId }} />
          </div>
        </DialogContent>
      </Dialog>

      <ConsolidateDialog
        pageId={pageId}
        entries={folding}
        open={folding.length > 0}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setFolding([]);
            setPicked(new Set());
          }
        }}
      />
    </div>
  );
});

/**
 * A labelled, countable, collapsible group — the rail's one repeating shape.
 *
 * Modelled on the property labels in the issue rail, so Pages does not invent a
 * second visual language for "here is a small titled thing on the right".
 */
const Section = observer(
  ({
    label,
    count,
    open,
    onToggle,
    empty,
    children,
  }: {
    label: string;
    count: number;
    open: boolean;
    onToggle: () => void;
    empty?: string;
    children: React.ReactNode;
  }) => (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={count === 0}
        className={cn(
          'flex items-center gap-1.5 text-left -ml-1',
          count > 0 && 'hover:text-foreground',
          count === 0 && 'cursor-default',
        )}
        onClick={onToggle}
      >
        {/* Nothing said these opened. A count on its own reads as a statistic,
            not a control, so the chevron is always drawn — dimmed rather than
            hidden, which would only move the problem to hover. */}
        <RiArrowRightSLine
          size={12}
          className={cn(
            'shrink-0 transition-transform text-muted-foreground',
            open && 'rotate-90',
            count === 0 && 'opacity-0',
          )}
        />
        <span className="text-xs">{label}</span>
        {count > 0 ? (
          <Badge variant="secondary">{count}</Badge>
        ) : (
          <span className="text-muted-foreground">{empty}</span>
        )}
      </button>

      {open && count > 0 && (
        <div className="flex flex-col gap-0.5">{children}</div>
      )}
    </div>
  ),
);

/**
 * A human writing a fact by hand.
 *
 * Until now the only way anything got in here was an agent calling `remember`,
 * which left the rail looking like a feed rather than something you own. A fact
 * written by a person skips the queue: a human writing it down *is* the review
 * step, and asking someone to approve their own sentence would be theatre.
 */
const AddFact = observer(
  ({ pageId, onDone }: { pageId: string; onDone: () => void }) => {
    const [content, setContent] = React.useState('');

    const { mutate: create } = useCreatePageEntryMutation({
      onSuccess: () => {
        setContent('');
        onDone();
      },
    });

    return (
      <div className="flex flex-col gap-2">
        <Textarea
          autoFocus
          rows={3}
          value={content}
          placeholder="One fact, in a sentence."
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
            setContent(event.currentTarget.value)
          }
        />
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            disabled={content.trim().length === 0}
            onClick={() =>
              create({ pageId, content: content.trim(), standing: true })
            }
          >
            Add
          </Button>
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <span className="text-muted-foreground">
          Goes straight into use — agents are given it from now on.
        </span>
      </div>
    );
  },
);
