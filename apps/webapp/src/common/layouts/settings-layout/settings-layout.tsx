import { SidebarProvider } from '@vantikhq/ui/components/sidebar';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { AllProviders } from 'common/wrappers/all-providers';

import { useContextStore } from 'store/global-context-provider';

import { SidebarNav } from './sidebar-nav';

interface SettingsProps {
  children: React.ReactNode;
}

export const SettingsLayout = observer(({ children }: SettingsProps) => {
  const { applicationStore } = useContextStore();

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      applicationStore.updateSideBar(!open);
    },
    [applicationStore],
  );

  return (
    <AllProviders>
      <SidebarProvider
        open={!applicationStore.sidebarCollapsed}
        onOpenChange={handleOpenChange}
      >
        <div className="h-[100vh] w-[100vw] flex">
          {/*
            The settings rows are text only, so a rail would collapse to a
            column of blank buttons. This nav hides outright instead, and the
            Sidebar carries its own width, so no wrapper is needed to hold it.
          */}
          <SidebarNav />

          {children}
        </div>
      </SidebarProvider>
    </AllProviders>
  );
});
