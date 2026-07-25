import { Button } from '@vantikhq/ui/components/button';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { PageEntryStatus } from 'common/types';

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
  const router = useRouter();
  const { workspaceSlug } = router.query;
  const { pagesStore, pageEntriesStore } = useContextStore();

  const { mutate: createPage } = useCreatePageMutation({
    onSuccess: (page) => goToPage(page.id),
  });

  // The front door is where you find out there is anything to review at all,
  // so it needs every page's entries and not just one page's.
  React.useEffect(() => {
    pageEntriesStore.loadAll();
  }, [pageEntriesStore]);

  const waiting = pageEntriesStore.getAllByStatus(
    PageEntryStatus.PROPOSED,
  ).length;

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

            {waiting > 0 && (
              <div className="rounded border border-border p-3 mt-2 flex items-center gap-3 flex-wrap">
                <span className="grow">
                  {waiting} {waiting === 1 ? 'fact is' : 'facts are'} waiting
                  for review across your pages.
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => router.push(`/${workspaceSlug}/pages/review`)}
                >
                  Review
                </Button>
              </div>
            )}

            <div className="mt-2">
              {pagesStore.getPages.length === 0 ? (
                <p className="text-muted-foreground">
                  No pages yet. Start one, or let an agent tell you what to
                  write — see the unanswered questions below.
                </p>
              ) : (
                <PageTree
                  onSelect={goToPage}
                  onCreateChild={(parentId) =>
                    createPage({ title: '', parentId })
                  }
                />
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
