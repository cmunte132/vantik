import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarProvider,
  SidebarSeparator,
} from '@vantikhq/ui/components/sidebar';
import {
  BookLine,
  BuildingLine,
  CodingLine,
  Inbox,
  MyIssues,
  Project,
  StackLine,
  TeamLine,
} from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import * as React from 'react';

import { GlobalShortcuts, IssueShortcutDialogs } from 'modules/shortcuts';

import { workspaceHref } from 'common/workspace-href';
import { AllProviders } from 'common/wrappers/all-providers';

import { useCurrentTeam } from 'hooks/teams';

import { useContextStore } from 'store/global-context-provider';

import { AccountMenu } from './account-menu';
import { Nav } from './nav';
import { ProductList } from './product-list';
import { SidebarActions } from './sidebar-actions';
import { TeamList } from './team-list';
import { useSidebarShortcut } from './use-sidebar-shortcut';
import { WorkspaceSwitcher } from './workspace-switcher';

interface LayoutProps {
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}

export const AppLayoutChild = observer(({ children }: LayoutProps) => {
  const { applicationStore, notificationsStore } = useContextStore();
  useSidebarShortcut();

  const {
    query: { workspaceSlug },
  } = useRouter();
  const team = useCurrentTeam();

  const collapsed = applicationStore.sidebarCollapsed;

  // Collapse state stays in the application store; the provider is told about
  // it rather than keeping a second copy that could drift from ⌘B.
  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      applicationStore.updateSideBar(!open);
    },
    [applicationStore],
  );

  return (
    <SidebarProvider open={!collapsed} onOpenChange={handleOpenChange}>
      <div className="h-[100vh] w-[100vw] flex">
        {/*
          ⌘B narrows the sidebar to a rail rather than removing it, so every
          top-level destination stays one click away at either width.
        */}
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <WorkspaceSwitcher />
            <SidebarActions />
          </SidebarHeader>

          <SidebarContent>
            <Nav
              links={[
                {
                  title: 'Inbox',
                  icon: Inbox,
                  href: workspaceHref(workspaceSlug, 'inbox'),
                  count: notificationsStore.unReadCount,
                  unread: true,
                },
                {
                  title: 'My issues',
                  icon: MyIssues,
                  href: workspaceHref(workspaceSlug, 'my-issues'),
                },
                {
                  title: 'Views',
                  icon: StackLine,
                  href: workspaceHref(workspaceSlug, 'views'),
                },
                {
                  title: 'Projects',
                  icon: Project,
                  href: workspaceHref(workspaceSlug, 'projects'),
                },
                {
                  title: 'Pages',
                  icon: BookLine,
                  href: workspaceHref(workspaceSlug, 'pages'),
                },
                // Background work is only background if there is somewhere to
                // go and look at it. The page existed and nothing linked to
                // it, which made a delegated run findable only by opening the
                // issue you had already walked away from.
                {
                  title: 'Agents',
                  icon: CodingLine,
                  href: workspaceHref(workspaceSlug, 'agent-runs'),
                },
                {
                  title: 'Teams',
                  icon: TeamLine,
                  href: workspaceHref(workspaceSlug, 'teams'),
                },
                // The group below lists the products one by one, and its label
                // is a label. This row is the way to the whole list, and it
                // sits beside Teams because the two lists are the same kind of
                // page for the two axes.
                {
                  title: 'Products',
                  icon: BuildingLine,
                  href: workspaceHref(workspaceSlug, 'products'),
                },
              ]}
            />

            <SidebarSeparator />

            {/*
              Products sit above the teams. The two are different axes: a
              product is what the company ships, and a team is who builds it.
              Reading the product first is what stops a person from treating a
              team as the product, which is the habit this axis exists to end.
            */}
            <ProductList />

            <TeamList />
          </SidebarContent>

          <SidebarFooter>
            <AccountMenu />
          </SidebarFooter>
        </Sidebar>

        <div
          className={cn(
            'w-full',
            collapsed && 'max-w-[calc(100vw_-_48px)]',
            !collapsed && 'max-w-[calc(100vw_-_248px)]',
          )}
        >
          {children}
        </div>
      </div>

      <GlobalShortcuts />

      {team && <IssueShortcutDialogs />}
    </SidebarProvider>
  );
});

export function AppLayout(props: LayoutProps) {
  return (
    <AllProviders>
      <AppLayoutChild {...props} />
    </AllProviders>
  );
}
