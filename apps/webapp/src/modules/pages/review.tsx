import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';

import { useContextStore } from 'store/global-context-provider';

import { Header } from './header';
import { ReviewQueue } from './review-queue';

/**
 * The workspace review inbox.
 *
 * Everything agents have asserted anywhere, waiting on a person. This is the
 * surface the work is actually shaped like — you clear the queue once rather
 * than visiting each page to find out whether it has anything — and it is the
 * same {@link ReviewQueue} the page-scoped dialog opens, given a wider scope.
 */
const ReviewView = observer(() => {
  const { pageEntriesStore } = useContextStore();

  // The per-page load only ever fills in the page you opened, so the inbox has
  // to ask for the rest before it can claim to show everything waiting.
  React.useEffect(() => {
    pageEntriesStore.loadAll();
  }, [pageEntriesStore]);

  return (
    <MainLayout header={<Header label="Review" />}>
      <ScrollArea className="h-[calc(100%_-_38px)] w-full">
        <div className="max-w-[80ch] mx-auto py-8 px-6 flex flex-col gap-6">
          <section className="flex flex-col gap-1">
            <h2>Review</h2>
            <p className="text-muted-foreground">
              Facts agents recorded while working, waiting on you. Anything you
              use here is given to agents that ask about its page from then on.
            </p>
          </section>

          <ReviewQueue scope={{ kind: 'workspace' }} />
        </div>
      </ScrollArea>
    </MainLayout>
  );
});

export function Review() {
  return <ReviewView />;
}

Review.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
