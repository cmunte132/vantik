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
import { AddLine, ChevronRight } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import type { TeamType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

import { TEAM_LINKS } from './settings-layout-constants';

export const TeamSettingsList = observer(() => {
  const currentUser = React.useContext(UserContext);
  const { teamsStore, workspaceStore } = useContextStore();

  const { query } = useRouter();
  const { workspaceSlug, settingsSection, teamIdentifier } = query;
  const teamAccessList = workspaceStore.getUserData(currentUser.id)?.teamIds;
  const teams = teamsStore.teams.filter((team: TeamType) =>
    teamAccessList.includes(team.id),
  );

  // Same reasoning as the app sidebar: derive open-ness from the route so the
  // team being edited is revealed once the stores hydrate, but let a toggle win.
  const [toggled, setToggled] = React.useState<Record<string, boolean>>({});

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        Teams
        <SidebarGroupAction asChild aria-label="Add team">
          <Link href={`/${workspaceSlug}/settings/new_team`}>
            <AddLine />
          </Link>
        </SidebarGroupAction>
      </SidebarGroupLabel>

      <SidebarMenu>
        {teams.map((team: TeamType) => (
          <Collapsible
            key={team.identifier}
            open={
              toggled[team.identifier] ?? team.identifier === teamIdentifier
            }
            onOpenChange={(open) => {
              setToggled((previous) => ({
                ...previous,
                [team.identifier]: open,
              }));
            }}
            className="group/collapsible"
          >
            <SidebarMenuItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton marker={false}>
                  <TeamIcon
                    preferences={team.preferences}
                    name={team.name}
                    className="!h-4 !w-4 shrink-0 [&>svg]:!h-3 [&>svg]:!w-3"
                  />
                  <span className="flex-1 truncate">{team.name}</span>
                  <ChevronRight
                    className="!size-3.5 shrink-0 text-sidebar-muted transition-transform
                      duration-200 group-data-[state=open]/collapsible:rotate-90"
                  />
                </SidebarMenuButton>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <SidebarMenuSub>
                  {TEAM_LINKS.map((item) => (
                    <SidebarMenuSubItem key={item.href}>
                      <SidebarMenuSubButton
                        asChild
                        isActive={
                          team.identifier === teamIdentifier &&
                          settingsSection === item.href
                        }
                      >
                        <Link
                          href={`/${workspaceSlug}/settings/teams/${team.identifier}/${item.href}`}
                        >
                          <span className="flex-1 truncate">{item.title}</span>
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
});
