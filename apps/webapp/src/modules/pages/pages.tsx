import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';

import { useContextStore } from 'store/global-context-provider';

import { useCreatePageMutation } from 'services/pages';

import { Header } from './header';
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
    <MainLayout
      header={<Header onCreate={() => createPage({ title: '' })} />}
    >
      <ScrollArea className="h-[calc(100%_-_38px)] w-full">
        <div className="max-w-[80ch] mx-auto py-8 px-6 flex flex-col gap-8">
          <section className="flex flex-col gap-2">
            <h2>Pages</h2>
            <p className="text-muted-foreground">
              Documentation people read, and the memory agents write into. A
              page is what the workspace has agreed; what agents assert waits on
              each page for review.
            </p>

            <div className="mt-2">
              {pagesStore.getPages.length === 0 ? (
                <p className="text-muted-foreground">
                  No pages yet. Start one, or let an agent tell you what to
                  write — see the unanswered questions below.
                </p>
              ) : (
                <PageTree onSelect={goToPage} />
              )}
            </div>
          </section>

          <KnowledgeGaps
            onCreatePage={(query) => createPage({ title: query })}
          />
        </div>
      </ScrollArea>
    </MainLayout>
  );
});

export function Pages() {
  return <PagesView />;
}

Pages.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
