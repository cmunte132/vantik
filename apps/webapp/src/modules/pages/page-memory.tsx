import { Button } from '@vantikhq/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import { Textarea } from '@vantikhq/ui/components/textarea';
import { ChevronRight } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

import { useCreatePageEntryMutation } from 'services/pages';

import { EntryRow } from './entry-row';
import { ReviewQueue } from './review-queue';

/**
 * What this page tells agents, stated on the page itself.
 *
 * This replaces a four-hundred-pixel moderation rail that sat permanently
 * beside the editor. Two things were wrong with that. It gave a task nobody was
 * doing — triage — the same standing as the one they had opened the page for,
 * and it never said what any of it *was*: rows of assertions appeared with a
 * name attached and no account of how they got there or how more would arrive.
 *
 * So this says the mechanism in one sentence, shows the counts, and offers one
 * way in. Deciding happens in {@link ReviewQueue}, which is its own surface
 * here and at the workspace inbox. Reading what agents are currently given
 * stays available, because "what does this page actually tell an agent" is a
 * fair question to ask while editing it — but it is read-only and folded away,
 * not thirty rows of buttons in your peripheral vision.
 */
export const PageMemory = observer(({ pageId }: { pageId: string }) => {
  const { pageEntriesStore } = useContextStore();
  const [reviewing, setReviewing] = React.useState(false);
  const [showStanding, setShowStanding] = React.useState(false);
  const [showSetAside, setShowSetAside] = React.useState(false);
  const [adding, setAdding] = React.useState(false);

  const byStatus = (status: PageEntryStatus): PageEntryType[] =>
    pageEntriesStore.getByStatus(pageId, status);

  const standing = byStatus(PageEntryStatus.STANDING);
  const waiting = byStatus(PageEntryStatus.PROPOSED);
  const setAside = byStatus(PageEntryStatus.ARCHIVED);
  const disputed = byStatus(PageEntryStatus.DISPUTED);

  return (
    <section className="border-t border-border mt-8 pt-4 mb-8 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2>Agent memory</h2>
        <p className="text-muted-foreground">
          {standing.length === 0
            ? 'Agents asking about this page are given the text above. They can also record short facts here as they work — nothing has been recorded yet.'
            : `Agents asking about this page are given the text above, plus ${standing.length} short ${
                standing.length === 1 ? 'fact' : 'facts'
              } they recorded here themselves as they worked.`}
        </p>
      </div>

      {waiting.length > 0 && (
        <div className="rounded border border-border p-3 flex items-center gap-3 flex-wrap">
          <span className="grow">
            {waiting.length} new {waiting.length === 1 ? 'fact is' : 'facts are'}{' '}
            waiting for you. No agent is given{' '}
            {waiting.length === 1 ? 'it' : 'them'} until you decide.
          </span>
          <Button variant="secondary" size="sm" onClick={() => setReviewing(true)}>
            Review
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Disclosure
          open={showStanding}
          onToggle={() => setShowStanding((open: boolean) => !open)}
          label={
            standing.length === 0
              ? 'Nothing is being given to agents yet'
              : `See what agents are given (${standing.length})`
          }
          disabled={standing.length === 0}
        />

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setAdding((open: boolean) => !open)}
        >
          Add a fact
        </Button>
      </div>

      {adding && <AddFact pageId={pageId} onDone={() => setAdding(false)} />}

      {showStanding && (
        <div className="flex flex-col gap-2">
          {standing.map((entry) => (
            <EntryRow key={entry.id} entry={entry} variant="reference" />
          ))}
        </div>
      )}

      {(setAside.length > 0 || disputed.length > 0) && (
        <div className="flex flex-col gap-2">
          <Disclosure
            open={showSetAside}
            onToggle={() => setShowSetAside((open: boolean) => !open)}
            label={[
              setAside.length > 0 ? `${setAside.length} set aside` : null,
              disputed.length > 0 ? `${disputed.length} marked wrong` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />

          {showSetAside && (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Kept on the record, never given to an agent.
              </p>
              {[...setAside, ...disputed].map((entry) => (
                <EntryRow key={entry.id} entry={entry} variant="reference" />
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog open={reviewing} onOpenChange={setReviewing}>
        <DialogContent className="max-w-[720px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Facts waiting on this page</DialogTitle>
          </DialogHeader>

          <ReviewQueue scope={{ kind: 'page', pageId }} />
        </DialogContent>
      </Dialog>
    </section>
  );
});

const Disclosure = observer(
  ({
    open,
    onToggle,
    label,
    disabled = false,
  }: {
    open: boolean;
    onToggle: () => void;
    label: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'flex items-center gap-1 text-muted-foreground',
        !disabled && 'hover:underline',
      )}
      onClick={onToggle}
    >
      {!disabled && (
        <ChevronRight
          size={12}
          className={cn('shrink-0 transition-transform', open && 'rotate-90')}
        />
      )}
      {label}
    </button>
  ),
);

/**
 * A human writing a fact by hand.
 *
 * Until now the only way anything got in here was an agent calling `remember`,
 * which left the panel looking like a feed rather than a thing you own. A fact
 * written by a person skips the queue and goes straight into use: a human
 * writing it down *is* the review step, and asking someone to approve their own
 * sentence would be theatre.
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
      <div className="rounded border border-border p-3 flex flex-col gap-2">
        <Textarea
          autoFocus
          rows={2}
          value={content}
          placeholder="One fact, in a sentence. “Deploys run under podman, not docker.”"
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
            setContent(event.currentTarget.value)
          }
        />
        <div className="flex items-center gap-2">
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
          <span className="text-muted-foreground ml-auto">
            Goes straight into use — agents are given it from now on
          </span>
        </div>
      </div>
    );
  },
);
