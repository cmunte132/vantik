'use client';

import { AvatarText } from '@vantikhq/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import { ChevronRight } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import React from 'react';

import { workspaceHref } from 'common/workspace-href';

import { useContextStore } from 'store/global-context-provider';

/**
 * The workspace was previously a bare 20px avatar with no name on it. Naming it
 * and showing the member count turns the top of the sidebar into a row that
 * says where you are, which is what the space was already spending.
 */
export const WorkspaceSwitcher = observer(() => {
  const { workspaceStore } = useContextStore();
  const { query, push } = useRouter();

  const workspace = workspaceStore.workspace;
  const memberCount = workspaceStore.usersOnWorkspaces.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-sidebar="rail-item"
        className="flex h-11 w-full items-center justify-center gap-[9px] rounded px-2
          text-left outline-none hover:bg-sidebar-hover focus-visible:ring-1
          focus-visible:ring-ring"
      >
        <AvatarText
          text={workspace.name}
          noOfChar={1}
          className="!h-6 !w-6 shrink-0"
        />

        <div className="min-w-0 flex-1" data-rail-hide>
          <div className="truncate font-medium text-sidebar-foreground">
            {workspace.name}
          </div>
          <div className="mt-0.5 truncate text-xs text-sidebar-muted">
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </div>
        </div>

        {/*
          The icon components take only {size, className, color}, so a
          `data-rail-hide` passed to one is dropped. The wrapper carries it.
        */}
        <span data-rail-hide className="flex shrink-0">
          <ChevronRight size={14} className="rotate-90 text-sidebar-muted" />
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="min-w-60" align="start">
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => {
              push(workspaceHref(query.workspaceSlug, 'settings', 'overview'));
            }}
          >
            Workspace settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              push(workspaceHref(query.workspaceSlug, 'settings', 'members'));
            }}
          >
            Invite &amp; manage members
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
