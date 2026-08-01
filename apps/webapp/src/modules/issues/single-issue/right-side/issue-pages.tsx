import { RiAddLine, RiCloseLine } from '@remixicon/react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@vantikhq/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@vantikhq/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import * as React from 'react';

import { useIssueData } from 'hooks/issues';

import {
  type RelatedPage,
  useCreatePageLinkMutation,
  useDeletePageLinkMutation,
  useRelatedPages,
} from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

/**
 * The documentation for this issue, reachable from the issue.
 *
 * The page view has had the other half of this since links landed — it lists
 * what it is linked to, and the issues whose prose mentions it. What was missing
 * was the direction a person actually works in: you open an issue and want the
 * runbook, and having to go and find the page first in order to link the issue
 * you are already looking at is the kind of detour nobody takes twice.
 *
 * Pages come from the synced store, so the picker is immediate and searchable
 * with no round trip. The links themselves are read on demand — an issue is
 * opened far more often than its pages change.
 */
export const IssuePages = observer(() => {
  const issue = useIssueData();
  const { data: pages } = useRelatedPages('ISSUE', issue?.id);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { workspaceSlug } = router.query;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['related-pages', 'ISSUE'] });
    // The page's own list is the same edges seen from the other end, so it is
    // stale the moment this one changes.
    queryClient.invalidateQueries({ queryKey: ['page-links'] });
  };

  const { mutate: remove } = useDeletePageLinkMutation({ onSuccess: refresh });

  const open = (pageId: string) => {
    router.push({
      pathname: '/[workspaceSlug]/pages/[pageId]',
      query: { workspaceSlug, pageId },
    });
  };

  return (
    <div className="flex flex-col items-start">
      <div className="w-full flex items-center justify-between">
        <div className="text-xs text-left">Pages</div>
        <AddPageLink issueId={issue.id} onAdded={refresh} />
      </div>

      {pages?.map((page: RelatedPage) => (
        <div key={page.linkId} className="w-full group flex items-center gap-1">
          <Button
            variant="link"
            className="px-0 h-7 truncate justify-start grow text-left"
            onClick={() => open(page.id)}
          >
            {page.title || 'Untitled page'}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="px-1 opacity-0 group-hover:opacity-100"
            aria-label={`Unlink ${page.title || 'Untitled page'}`}
            onClick={() => remove({ pageId: page.id, linkId: page.linkId })}
          >
            <RiCloseLine size={12} />
          </Button>
        </div>
      ))}
    </div>
  );
});

const AddPageLink = observer(
  ({ issueId, onAdded }: { issueId: string; onAdded: () => void }) => {
    const [open, setOpen] = React.useState(false);
    const { pagesStore } = useContextStore();

    const { mutate: create } = useCreatePageLinkMutation({
      onSuccess: () => {
        setOpen(false);
        onAdded();
      },
    });

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="px-1">
            <RiAddLine size={14} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[280px] p-0">
          <Command>
            <CommandInput placeholder="Find a page…" />
            <CommandList>
              <CommandEmpty>No pages match.</CommandEmpty>
              {pagesStore.getPages.map(
                (page: { id: string; title: string }) => (
                  <CommandItem
                    key={page.id}
                    value={`page ${page.title}`}
                    // The edge is stored against the page, so linking from either
                    // end is the same write and a repeat is the existing link.
                    onSelect={() =>
                      create({
                        pageId: page.id,
                        entityType: 'ISSUE',
                        entityId: issueId,
                      })
                    }
                  >
                    {page.title || 'Untitled page'}
                  </CommandItem>
                ),
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  },
);
