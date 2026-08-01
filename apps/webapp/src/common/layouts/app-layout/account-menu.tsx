'use client';

import { RiMoreLine } from '@remixicon/react';
import { AvatarText } from '@vantikhq/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import posthog from 'posthog-js';
import React from 'react';
import { signOut } from 'supertokens-auth-react/recipe/session';

import { deleteCookies } from 'common/common-utils';
import { workspaceHref } from 'common/workspace-href';

import { UserContext } from 'store/user-context';

/**
 * The footer used to hold a single Help button and nothing else, while the
 * account had no affordance anywhere. Help moves in here alongside the
 * user-scoped actions, which is where people already look for them.
 */
export const AccountMenu = observer(() => {
  const currentUser = React.useContext(UserContext);
  const { query, push, replace } = useRouter();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-sidebar="rail-item"
        className="flex h-[46px] w-full items-center justify-center gap-[9px] px-2
          text-left outline-none hover:bg-sidebar-hover focus-visible:ring-1
          focus-visible:ring-ring"
      >
        <AvatarText
          text={currentUser.fullname}
          className="!h-[22px] !w-[22px] shrink-0 [&>span]:!rounded-full"
        />

        <div className="min-w-0 flex-1" data-rail-hide>
          <div className="truncate text-sm font-medium text-sidebar-foreground">
            {currentUser.fullname}
          </div>
          <div className="mt-0.5 truncate text-xs text-sidebar-muted">
            {currentUser.email}
          </div>
        </div>

        <span data-rail-hide className="flex shrink-0">
          <RiMoreLine size={14} className="text-sidebar-muted" />
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="min-w-60" align="start" side="top">
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => {
              push(
                workspaceHref(
                  query.workspaceSlug,
                  'settings',
                  'account',
                  'profile',
                ),
              );
            }}
          >
            Preferences
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              window.open('https://docs.vantik.dev', '_blank');
            }}
          >
            Help from docs
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={async () => {
            posthog.reset(true);
            deleteCookies();
            await signOut();

            replace('/auth');
          }}
        >
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
