import type React from 'react';

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@vantikhq/ui/components/resizable';

import { AppLayout } from 'common/layouts/app-layout';
import { ContentBox } from 'common/layouts/content-box';

import { IssueDataContext, useIssueDataFromStore } from 'hooks/issues';

import { IssueStoreInit } from 'store/issue-store-provider';

import { Header } from './header';
import { NotificationsList } from './notifications-list';
import { InboxUpdateView } from './update-view';

export function InboxSingleIssue() {
  const issue = useIssueDataFromStore(false);

  return (
    <IssueDataContext.Provider value={{ issue }}>
      <main className="flex flex-col h-[100vh]">
        <Header />
        <ContentBox>
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel
              maxSize={50}
              defaultSize={24}
              minSize={16}
              collapsible
              collapsedSize={16}
            >
              <div className="flex flex-col h-full">
                <h2 className="text-lg pl-4 pt-4 font-medium"> Inbox </h2>
                <NotificationsList />
              </div>
            </ResizablePanel>
            <ResizableHandle />
            {/*
              The updates, and nothing else. This panel used to hold the whole
              issue page — the editor and the property rail — which made the
              inbox a narrower copy of a page one click away, and left the
              reader 494px on a 1280px window. What arrived is what the person
              came to read, so it gets the panel.
            */}
            <ResizablePanel collapsible collapsedSize={0} className="min-w-0">
              <InboxUpdateView />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ContentBox>
      </main>
    </IssueDataContext.Provider>
  );
}

InboxSingleIssue.getLayout = function getLayout(page: React.ReactElement) {
  return (
    <AppLayout>
      <IssueStoreInit sideView={false}>{page}</IssueStoreInit>
    </AppLayout>
  );
};
