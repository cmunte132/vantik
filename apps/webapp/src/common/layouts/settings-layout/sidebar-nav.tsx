'use client';

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@vantikhq/ui/components/sidebar';
import { ChevronLeft } from '@vantikhq/ui/icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRouter } from 'next/router';
import React from 'react';

import { useContextStore } from 'store/global-context-provider';

import {
  ACCOUNT_LINKS,
  WORKSPACE_LINKS,
  type LinkItem,
} from './settings-layout-constants';
import { TeamSettingsList } from './team-settings-list';

/**
 * Shares the app sidebar's primitives rather than its own copy of the class
 * strings. The two navs had drifted apart precisely because they were
 * hand-rolled twice.
 */
export function SidebarNav() {
  const router = useRouter();
  const { query, push } = router;
  const { teamsStore } = useContextStore();
  const pathname = usePathname();
  const {
    workspaceSlug,
    teamIdentifier,
    settingsSection = WORKSPACE_LINKS[0].href,
  } = query;

  function isActive(item: LinkItem) {
    if (pathname.includes('integrations') || pathname.includes('actions')) {
      return pathname.includes(item.href);
    }

    return settingsSection === item.href;
  }

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <button
          type="button"
          onClick={() => {
            push(
              `/${query.workspaceSlug}/team/${teamsStore.teams[0].identifier}/all`,
            );
          }}
          className="flex h-9 w-full items-center gap-1.5 rounded px-2 text-left font-medium
            text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-hover
            focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronLeft size={16} className="shrink-0" />
          Settings
        </button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarMenu>
            {WORKSPACE_LINKS.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  asChild
                  isActive={!teamIdentifier && isActive(item)}
                >
                  <Link href={`/${workspaceSlug}/settings/${item.href}`}>
                    <span className="flex-1 truncate">{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>My account</SidebarGroupLabel>
          <SidebarMenu>
            {ACCOUNT_LINKS.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  asChild
                  isActive={settingsSection === item.href}
                >
                  <Link
                    href={`/${workspaceSlug}/settings/account/${item.href}`}
                  >
                    <span className="flex-1 truncate">{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <TeamSettingsList />
      </SidebarContent>
    </Sidebar>
  );
}
