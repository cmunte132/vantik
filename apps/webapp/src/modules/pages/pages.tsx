import { Button } from '@vantikhq/ui/components/button';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';

import { useContextStore } from 'store/global-context-provider';

import { useCreatePageMutation } from 'services/pages';

import { KnowledgeGaps } from './knowledge-gaps';
import { PageTree, usePageNavigation } from './page-tree';

/**
 * The knowledge bank's front door: the tree, and what the bank has been asked
 * for but could not answer.
 */
const PagesView = observer(() => {
  const goToPage = usePageNavigation();
  const { pagesStore } = useContextStore();

  const { mutate: createPage } = useCreatePageMutation({
    onSuccess: (page) => goToPage(page.id),
  });

  return (
    <ScrollArea className="h-full w-full">
      <div className="max-w-[80ch] mx-auto py-8 px-6 flex flex-col gap-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-medium">Pages</h1>
            <p className="text-muted-foreground mt-1">
              Documentation people read, and the memory agents write into. What
              a page says is what the workspace has agreed; what agents assert
              waits on each page for review.
            </p>
          </div>

          <Button
            variant="secondary"
            className="shrink-0"
            onClick={() => createPage({ title: 'Untitled page' })}
          >
            New page
          </Button>
        </div>

        <section className="flex flex-col gap-2">
          <h2>Tree</h2>
          {pagesStore.getPages.length === 0 ? (
            <p className="text-muted-foreground">
              No pages yet. Start one, or let an agent tell you what to write —
              see the unanswered questions below.
            </p>
          ) : (
            <PageTree onSelect={goToPage} />
          )}
        </section>

        <KnowledgeGaps
          onCreatePage={(query) =>
            createPage({
              title: query,
              descriptionMarkdown: `Written in answer to a question agents asked ${''}and the bank could not answer.`,
            })
          }
        />
      </div>
    </ScrollArea>
  );
});

export function Pages() {
  return <PagesView />;
}

Pages.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
