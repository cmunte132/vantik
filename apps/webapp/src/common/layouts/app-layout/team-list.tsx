'use client';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@vantikhq/ui/components/collapsible';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@vantikhq/ui/components/sidebar';
import { TeamIcon } from '@vantikhq/ui/components/team-icon';
import {
  AddLine,
  ChevronRight,
  Cycle,
  IssuesLine,
  StackLine,
} from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import type { TeamType } from 'common/types';

import { useCurrentTeam } from 'hooks/teams';
import { useCurrentWorkspace } from 'hooks/workspace';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

import { checkIsActive, type Link } from './nav';

export const TeamList = observer(() => {
  const currentUser = React.useContext(UserContext);
  const { teamsStore, workspaceStore } = useContextStore();
  const pathname = usePathname();
  // If the team exists in the route path
  const team = useCurrentTeam();
  const teamAccessList =
    workspaceStore.getUserData(currentUser.id)?.teamIds ?? [];
  const teams = teamsStore.teams.filter((team: TeamType) =>
    teamAccessList.includes(team.id),
  );
  const workspace = useCurrentWorkspace();

  /*
   * `defaultOpen` is only read when the Collapsible mounts, and on first render
   * the stores have not hydrated yet, so the team you are actually looking at
   * stayed shut. Deriving open-ness from the current team instead means it
   * opens as soon as that resolves, while an explicit toggle still wins.
   */
  const [toggled, setToggled] = React.useState<Record<string, boolean>>({});

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        Your teams
        <SidebarGroupAction asChild aria-label="Add team">
          <NextLink href={`/${workspace.slug}/settings/new_team`}>
            <AddLine />
          </NextLink>
        </SidebarGroupAction>
      </SidebarGroupLabel>

      <SidebarMenu>
        {teams.map((teamItem: TeamType) => {
          let links: Link[] = [
            {
              title: 'Issues',
              icon: IssuesLine,
              href: `/${workspace.slug}/team/${teamItem.identifier}/all`,
              activePaths: [`/${workspace.slug}/issue/${teamItem.identifier}-`],
            },
            {
              title: 'Views',
              icon: StackLine,
              href: `/${workspace.slug}/team/${teamItem.identifier}/views`,
            },
          ];

          if (teamItem.preferences.cyclesEnabled) {
            links = [
              ...links,
              ...[
                {
                  title: 'Cycles',
                  icon: Cycle,
                  strict: true,
                  href: `/${workspace.slug}/team/${teamItem.identifier}/cycles`,
                },
                {
                  title: 'Current',
                  icon: Cycle,
                  href: `/${workspace.slug}/team/${teamItem.identifier}/cycles/current`,
                },
              ],
            ];
          }

          /*
           * Collapsed to a rail the submenu is hidden, so the active row would
           * be invisible and nothing would say where you are. Carrying the
           * child's active state up to the team row fixes that, and expanded it
           * reads as the trail you actually took: Engineering › Issues.
           */
          const hasActiveChild = links.some((link) =>
            checkIsActive(pathname, link.href, link.activePaths, link.strict),
          );

          return (
            <Collapsible
              key={teamItem.id}
              open={toggled[teamItem.id] ?? teamItem.id === team?.id}
              onOpenChange={(open) => {
                setToggled((previous) => ({
                  ...previous,
                  [teamItem.id]: open,
                }));
              }}
              className="group/collapsible"
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  {/*
                    The team row toggles rather than navigates, so it carries no
                    brand marker — that indicator means "the page you are on".
                  */}
                  <SidebarMenuButton
                    isActive={hasActiveChild}
                    tooltip={teamItem.name}
                  >
                    <TeamIcon
                      preferences={teamItem.preferences}
                      name={teamItem.name}
                      className="!h-4 !w-4 shrink-0 [&>svg]:!h-3 [&>svg]:!w-3"
                    />
                    <span className="flex-1 truncate">{teamItem.name}</span>
                    <span data-rail-hide className="flex shrink-0">
                      <ChevronRight
                        className="!size-3.5 text-sidebar-muted transition-transform
                          duration-200 group-data-[state=open]/collapsible:rotate-90"
                      />
                    </span>
                  </SidebarMenuButton>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <SidebarMenuSub>
                    {links.map((link) => (
                      <SidebarMenuSubItem key={link.href}>
                        <SidebarMenuSubButton
                          asChild
                          isActive={checkIsActive(
                            pathname,
                            link.href,
                            link.activePaths,
                            link.strict,
                          )}
                        >
                          <NextLink href={link.href}>
                            {link.icon && <link.icon />}
                            <span className="flex-1 truncate">
                              {link.title}
                            </span>
                          </NextLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
});
