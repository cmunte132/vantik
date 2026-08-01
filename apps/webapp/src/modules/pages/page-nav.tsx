import { RiAddLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { useCreatePageMutation } from 'services/pages';

import { PageTree, usePageNavigation } from './page-tree';

/**
 * The page tree, beside the page you are reading.
 *
 * Without it a page was a dead end: you arrived from the index, and the only
 * way to another page was back out and in again. Documentation is read by
 * following it sideways — a runbook sends you to the page about the thing it
 * mentions — so the tree has to be present while you are reading, not only
 * before you start.
 *
 * A child of the page rather than of the app sidebar, because the app sidebar
 * is global navigation and this is navigation within one section, the same
 * split every wiki settles on.
 */
export const PageNav = observer(
  ({ activePageId }: { activePageId: string }) => {
    const goToPage = usePageNavigation();
    const { mutate: createPage } = useCreatePageMutation({
      onSuccess: (page) => goToPage(page.id),
    });

    return (
      <div className="w-[220px] shrink-0 border-r border-border h-full flex flex-col">
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <h2 className="text-muted-foreground">All pages</h2>
          <Button
            variant="ghost"
            size="sm"
            aria-label="New page"
            onClick={() => createPage({ title: '' })}
          >
            <RiAddLine size={14} />
          </Button>
        </div>

        <ScrollArea className="grow px-2 pb-3">
          <PageTree
            activePageId={activePageId}
            onSelect={goToPage}
            onCreateChild={(parentId) => createPage({ title: '', parentId })}
          />
        </ScrollArea>
      </div>
    );
  },
);
