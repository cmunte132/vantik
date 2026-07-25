import { RoleEnum } from '@vantikhq/types';
import { Loader } from '@vantikhq/ui/components/loader';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { SettingSection } from 'modules/settings/setting-section';

import { useGetAgentsQuery } from 'services/users/get-agents';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

import { AgentItem } from './agent-item';
import { ConnectPanel } from './connect-panel';

/**
 * Provisioning surface for agent accounts: the connect panel — name it,
 * generate a token, copy the config for your harness — and the agents it has
 * produced, each revocable. An agent acts as its own identity in the workspace,
 * so minting one is admin-only; non-admins see why they cannot.
 */
export const Agents = observer(() => {
  const { workspaceStore } = useContextStore();
  const currentUser = React.useContext(UserContext);
  const userRole = workspaceStore.getUserData(currentUser.id)?.role;
  const isAdmin = userRole === RoleEnum.ADMIN;

  const { data: agents, isLoading } = useGetAgentsQuery();

  return (
    <SettingSection
      title="Agents"
      description="Provision an agent account so an LLM agent — your Claude Code or another MCP client — acts as its own identity in this workspace, with its edits attributed to the agent rather than to you."
    >
      {!isAdmin && (
        <p className="text-muted-foreground">
          Only workspace admins can provision agents.
        </p>
      )}

      {isAdmin && (
        <div className="flex flex-col">
          <ConnectPanel />

          <h4 className="text-base mb-3">Agents</h4>

          {isLoading && <Loader />}
          {agents?.map((agent) => (
            <AgentItem key={agent.id} agent={agent} />
          ))}
          {!isLoading && agents?.length === 0 && (
            <p className="text-muted-foreground">
              No agents yet. Generate a token above to create one.
            </p>
          )}
        </div>
      )}
    </SettingSection>
  );
});
