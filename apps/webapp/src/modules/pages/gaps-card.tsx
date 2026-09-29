import type {
  KnowledgeOverviewGap,
  KnowledgeOverviewResearch,
} from '@vantikhq/types';

import { Button } from '@vantikhq/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { Textarea } from '@vantikhq/ui/components/textarea';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import type { PageType } from 'common/types';

import {
  useAnswerGapMutation,
  useCreatePageEntryMutation,
} from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { age, ago, CARD } from './trust';

interface GapsCardProps {
  gaps: KnowledgeOverviewGap[];
  research: KnowledgeOverviewResearch[];
  closedThisWeek: number;
  onWritePage: (query: string) => void;
}

/**
 * The questions agents asked more than once and could not answer, and the
 * ones an agent researches now. A person answers a gap with a page or with
 * one fact.
 */
export const GapsCard = observer(
  ({ gaps, research, closedThisWeek, onWritePage }: GapsCardProps) => {
    const [answering, setAnswering] = React.useState<KnowledgeOverviewGap>();

    return (
      <div className={cn(CARD, 'p-4 flex flex-col gap-3')}>
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-semibold">
            Gaps agents could not close
          </span>
          <span className="text-xs text-muted-foreground">
            Asked more than once, and not in the code or the issues
          </span>
        </div>

        {gaps.length === 0 && (
          <span className="text-muted-foreground">
            None open. When agents ask the same thing twice and find nothing, it
            shows here.
          </span>
        )}

        {gaps.map((gap) => (
          <div
            key={gap.id}
            className="flex items-start gap-2 pb-2.5 border-b border-grayAlpha-100 last:border-0"
          >
            <div className="flex flex-col gap-1 grow min-w-0">
              <span className="font-medium leading-snug break-words">
                {gap.query}
              </span>
              <span className="text-xs font-medium text-[oklch(48%_0.17_45)] dark:text-[oklch(80%_0.14_45)]">
                Asked by {gap.count} runs · last {ago(gap.lastAskedAt)}
              </span>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className="shrink-0">
                  Answer
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setAnswering(gap)}>
                  Add a fact to a page
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onWritePage(gap.query)}>
                  Write a page
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}

        {research.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted-foreground">
              In the background
            </span>
            {research.map((item) => (
              <div key={item.gapId} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0 bg-[oklch(60%_0.13_240)] shadow-[0_0_0_3px_oklch(60%_0.13_240/0.2)]" />
                  <span className="grow leading-snug break-words">
                    {item.query}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground pl-4">
                  An agent is researching
                  {item.activity ? ` · ${item.activity}` : ''} ·{' '}
                  {age(item.startedAt)}
                </span>
              </div>
            ))}
          </div>
        )}

        {closedThisWeek > 0 && (
          <span className="text-xs text-muted-foreground">
            {closedThisWeek === 1
              ? 'One gap was closed this week.'
              : `${closedThisWeek} gaps were closed this week.`}
          </span>
        )}

        <AnswerDialog gap={answering} onClose={() => setAnswering(undefined)} />
      </div>
    );
  },
);

/**
 * One fact, on a page the person picks, that answers the gap. A fact a
 * person writes goes straight into use, and it closes the gap.
 */
const AnswerDialog = observer(
  ({ gap, onClose }: { gap?: KnowledgeOverviewGap; onClose: () => void }) => {
    const { pagesStore } = useContextStore();
    const [pageId, setPageId] = React.useState<string>();
    const [content, setContent] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const { mutate: answer } = useAnswerGapMutation({
      onSuccess: () => close(),
      onError: setError,
    });
    const { mutate: create, isPending } = useCreatePageEntryMutation({
      onMutate: () => setError(null),
      onSuccess: (entry) => gap && answer({ gapId: gap.id, entryId: entry.id }),
      onError: setError,
    });

    const close = () => {
      setContent('');
      setPageId(undefined);
      setError(null);
      onClose();
    };

    const pages: PageType[] = [...pagesStore.getPages].sort(
      (a: PageType, b: PageType) => a.title.localeCompare(b.title),
    );

    return (
      <Dialog open={Boolean(gap)} onOpenChange={(open) => !open && close()}>
        <DialogContent className="p-0 gap-0 min-w-[min(520px,calc(100vw-32px))] sm:max-w-[520px]">
          <DialogHeader className="text-left px-5 pt-5 pb-3">
            <DialogTitle className="font-normal">
              Answer with a fact
            </DialogTitle>
            <p className="text-muted-foreground">{gap?.query}</p>
          </DialogHeader>

          <div className="px-5 pb-5 flex flex-col gap-3">
            <Select value={pageId} onValueChange={setPageId}>
              <SelectTrigger>
                <SelectValue placeholder="The page it belongs on" />
              </SelectTrigger>
              <SelectContent className="max-h-[300px]">
                {pages.map((page) => (
                  <SelectItem key={page.id} value={page.id}>
                    {page.title || 'Untitled page'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Textarea
              rows={3}
              value={content}
              placeholder="One fact, in a sentence."
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                setContent(event.currentTarget.value)
              }
            />

            {error && <span className="text-destructive">{error}</span>}

            <div className="flex items-center gap-2">
              <span className="grow text-xs text-muted-foreground">
                Agents are given it from now on, and the gap closes.
              </span>
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!pageId || content.trim().length === 0 || isPending}
                onClick={() =>
                  pageId &&
                  create({ pageId, content: content.trim(), standing: true })
                }
              >
                Add the fact
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  },
);
