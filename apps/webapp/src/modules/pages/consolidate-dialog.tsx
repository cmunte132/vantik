import { Button } from '@vantikhq/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import { Textarea } from '@vantikhq/ui/components/textarea';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import type { PageEntryType } from 'common/types';

import { useConsolidatePageMutation, usePageMarkdown } from 'services/pages';

/**
 * Folding notes into the page.
 *
 * This is the step that was missing, and its absence is what made accepting a
 * note feel like it did nothing: a fact could be approved, and the page it was
 * approved on looked exactly the same afterwards. The two are genuinely
 * separate channels — a note is context handed to an agent, not documentation —
 * but there had to be a way across, or the notes pile up beside a page that
 * never learns anything.
 *
 * The prose is written here rather than generated, because deciding how a set
 * of facts reads as a narrative is the judgment being asked for. The notes are
 * appended verbatim as a starting point and the text is yours to rewrite; what
 * the server guarantees is only that whatever you fold in stops being served
 * separately, so a reader is never handed the same fact twice — once as prose
 * and once as the note it was written from.
 */
export const ConsolidateDialog = observer(
  ({
    pageId,
    entries,
    open,
    onOpenChange,
  }: {
    pageId: string;
    entries: PageEntryType[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    const { data: page } = usePageMarkdown(pageId, open);
    const [markdown, setMarkdown] = React.useState('');

    const { mutate: consolidate, isPending } = useConsolidatePageMutation({
      onSuccess: () => onOpenChange(false),
    });

    // Reset each time it opens: the body may have moved on since last time, and
    // saving a stale draft would silently undo whatever happened in between.
    React.useEffect(() => {
      if (!open || page === undefined) {
        return;
      }

      const body = page.descriptionMarkdown?.trimEnd() ?? '';
      const notes = entries.map((entry) => `- ${entry.content}`).join('\n');

      setMarkdown(body ? `${body}\n\n${notes}\n` : `${notes}\n`);
    }, [open, page, entries]);

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="p-0 gap-0 min-w-[720px] sm:max-w-[720px]">
          <DialogHeader className="text-left px-6 pt-6 pb-4 border-b border-border">
            <DialogTitle className="font-normal">
              Write {entries.length} {entries.length === 1 ? 'note' : 'notes'}{' '}
              into the page
            </DialogTitle>
            <p className="text-muted-foreground">
              Appended at the end — edit them into the page however it should
              read. Once saved they are part of the document and stop being
              given to agents separately, so nothing is said twice.
            </p>
          </DialogHeader>

          <div className="px-6 py-4">
            <Textarea
              rows={16}
              value={markdown}
              className="font-mono resize-none"
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                setMarkdown(event.currentTarget.value)
              }
            />
          </div>

          <div className="px-6 py-3 border-t border-border flex items-center gap-2">
            <span className="text-muted-foreground">
              You can undo this from the page history.
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={isPending || markdown.trim().length === 0}
                onClick={() =>
                  consolidate({
                    pageId,
                    descriptionMarkdown: markdown,
                    entryIds: entries.map((entry) => entry.id),
                  })
                }
              >
                Save to the page
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  },
);
