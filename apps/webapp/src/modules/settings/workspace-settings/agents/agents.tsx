import { RoleEnum, type AgentSummary } from '@vantikhq/types';
import { Loader } from '@vantikhq/ui/components/loader';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { AgentItem } from 'modules/settings/personal-settings/api/agents/agent-item';
import { SettingSection } from 'modules/settings/setting-section';

import { useCurrentWorkspace } from 'hooks/workspace';

import { useGetAgentsQuery } from 'services/users/get-agents';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

/**
 * Every agent operating in this workspace, for an admin.
 *
 * Read-only apart from revoke, and deliberately so: provisioning moved to
 * account settings, where the person who will actually use the credential can
 * reach it. What stays here is oversight — agents act as identities inside a
 * workspace and author changes attributed to them, so an admin needs to see
 * every one operating here and be able to cut off one they did not create.
 *
 * Grouped by ownership. A personal agent belongs to someone and is their
 * business first; a workspace agent acts for the whole workspace and is
 * nobody's personal credential. Telling them apart is the point of storing
 * ownership at all.
 */
export const Agents = observer(() => {
  const { workspaceStore } = useContextStore();
  const currentUser = React.useContext(UserContext);
  const workspace = useCurrentWorkspace();
  const isAdmin =
    workspaceStore.getUserData(currentUser.id)?.role === RoleEnum.ADMIN;

  // Listing everything is admin-only, so asking as anybody else earns a 403.
  const { data: agents, isLoading } = useGetAgentsQuery(
    workspace?.id,
    isAdmin && Boolean(workspace?.id),
    'all',
  );

  const workspaceOwned = (agents ?? []).filter(
    (agent: AgentSummary) => agent.ownership === 'workspace',
  );
  // Agents provisioned before ownerUserId was written read as null. They are
  // shown here rather than being invisible on both screens — the personal
  // screen cannot claim them, so this is the only place they exist.
  const personal = (agents ?? []).filter(
    (agent: AgentSummary) => agent.ownership !== 'workspace',
  );

  return (
    <SettingSection
      title="Agents"
      description="Every agent account operating in this workspace. Provision your own from account settings; this view is for seeing what exists and cutting off access."
    >
      {!isAdmin && (
        <p className="text-muted-foreground">
          Only workspace admins can see every agent. Your own are in account
          settings, beside your personal access tokens.
        </p>
      )}

      {isAdmin && (
        <div className="flex flex-col gap-6">
          {isLoading && <Loader />}

          {!isLoading && agents?.length === 0 && (
            <p className="text-muted-foreground">
              No agents in this workspace yet.
            </p>
          )}

          {workspaceOwned.length > 0 && (
            <div className="flex flex-col">
              <h4 className="text-base mb-3">Workspace agents</h4>
              {workspaceOwned.map((agent: AgentSummary) => (
                <AgentItem
                  key={agent.id}
                  agent={agent}
                  workspaceId={workspace.id}
                />
              ))}
            </div>
          )}

          {personal.length > 0 && (
            <div className="flex flex-col">
              <h4 className="text-base mb-3">Personal agents</h4>
              <p className="text-muted-foreground mb-3 text-sm">
                Owned by individual members. You can revoke one, but its owner
                manages it from their own settings.
              </p>
              {personal.map((agent: AgentSummary) => (
                <AgentItem
                  key={agent.id}
                  agent={agent}
                  workspaceId={workspace.id}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </SettingSection>
  );
});
