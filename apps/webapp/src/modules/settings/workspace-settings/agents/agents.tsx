/* eslint-disable @typescript-eslint/no-explicit-any */
import { useQueryClient } from '@tanstack/react-query';
import { RoleEnum, type AgentSummary } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { Loader } from '@vantikhq/ui/components/loader';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { AgentItem } from 'modules/settings/personal-settings/api/agents/agent-item';
import { SettingSection } from 'modules/settings/setting-section';

import { workspaceHref } from 'common/workspace-href';

import { useCurrentWorkspace } from 'hooks/workspace';

import { useClearRevokedAgentsMutation } from 'services/users/clear-revoked-agents';
import { useGetAgentsQuery } from 'services/users/get-agents';
import { useUpdateWorkspacePreferencesMutation } from 'services/workspace';
import {
  type CredentialHandle,
  useWorkspaceCredentials,
  useWorkspaceRecord,
  workspaceRecordKey,
} from 'services/workspace-credentials';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

import { CredentialBlock } from './credential-block';
import { ModelAccess } from './model-access';
import { ReviewCycle } from './review-cycle';

/**
 * What agent work in this workspace runs on, and who may act here.
 *
 * One `SettingSection` per topic, the way every other settings page is built:
 * what a thing is and why it matters belongs in the section's own description
 * column, not in headings invented inside the content.
 *
 * The order is the order of consequence. A missing model key blocks every run
 * in the workspace and is the reason the delegate button refuses; a stale agent
 * account blocks nothing. So credentials come first and the account list — the
 * part that used to be the whole page — comes last.
 *
 * Provisioning stays absent by design: personal agents are minted from account
 * settings, where the person who will use the credential can reach them. What
 * belongs here is oversight.
 */
export const Agents = observer(() => {
  const { workspaceStore } = useContextStore();
  const currentUser = React.useContext(UserContext);
  const workspace = useCurrentWorkspace();
  const {
    query: { workspaceSlug },
  } = useRouter();
  const isAdmin =
    workspaceStore.getUserData(currentUser.id)?.role === RoleEnum.ADMIN;

  // Both listings are admin-only server-side, so asking as anybody else earns a
  // 403 and an error state that says nothing useful.
  const enabled = isAdmin && Boolean(workspace?.id);

  const { data: agents, isLoading } = useGetAgentsQuery(
    workspace?.id,
    enabled,
    'all',
  );
  const { data: credentials } = useWorkspaceCredentials(enabled);
  const { data: record } = useWorkspaceRecord(enabled ? workspace?.id : undefined);
  const queryClient = useQueryClient();

  const { mutate: clearRevoked, isPending: isClearing } =
    useClearRevokedAgentsMutation();

  const { mutate: updatePreferences } = useUpdateWorkspacePreferencesMutation({
    // The mutation refreshes the user query, which does not carry preferences.
    // Without this the menus snap back to their old values.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [workspaceRecordKey()] }),
  });

  const agentRuns = (record?.preferences as any)?.agentRuns ?? {};

  const handle = (kind: string): CredentialHandle | undefined =>
    (credentials ?? []).find((entry) => entry.kind === kind);

  // A revoked agent can do nothing and never will again, so it is folded away
  // rather than occupying the same space as a live one forever.
  const active = (agents ?? []).filter((agent: AgentSummary) => agent.active);
  const revoked = (agents ?? []).filter((agent: AgentSummary) => !agent.active);
  const [showRevoked, setShowRevoked] = React.useState(false);

  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        <h2 className="text-xl"> Agents </h2>
        <SettingSection
          title="Agents"
          description="What agent work in this workspace runs on, and which agent accounts can act here."
        >
          <p className="text-muted-foreground">
            Only workspace admins can manage agent credentials or see every
            agent. Your own are in account settings, beside your personal access
            tokens.
          </p>
        </SettingSection>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl"> Agents </h2>

      <SettingSection
        title="Model access"
        description="The providers agent runs can call, and what they run on by default. Agents never borrow whatever powers Vantik's own AI features: an agent works for as long as the issue takes and spends accordingly, so somebody here decides to pay for that deliberately. Without a key, no agent runs."
      >
        <ModelAccess
          credentials={credentials ?? []}
          defaults={agentRuns.model ?? {}}
          onDefaultsChange={(model) =>
            // The server merges preferences one level deep only, so everything
            // under `agentRuns` is rebuilt here rather than delegated —
            // writing it wholesale would drop `repo` and `phases` beside it.
            updatePreferences({ agentRuns: { ...agentRuns, model } } as any)
          }
        />
      </SettingSection>

      <SettingSection
        title="How the work is checked"
        description="What happens between an agent finishing and you seeing a pull request. An agent grading its own diff is worth nothing, so a second one — which did not write the code — reads it against the issue, and what it finds goes back to be fixed. That costs money, which is why the ceiling is here beside the switch."
      >
        <ReviewCycle
          phases={agentRuns.phases ?? {}}
          limits={agentRuns.limits ?? {}}
          onChange={({ phases, limits }) =>
            // The server merges preferences one level deep only, so everything
            // under `agentRuns` is rebuilt here rather than delegated.
            updatePreferences({
              agentRuns: { ...agentRuns, phases, limits },
            } as any)
          }
        />
      </SettingSection>

      <SettingSection
        title="Repository access"
        description="How a run pushes a branch and opens a pull request. The token never enters the sandbox — the agent produces a patch and Vantik pushes it, so a prompt-injected agent has nothing to steal."
      >
        <CredentialBlock
          kind="GIT_TOKEN"
          whenAbsent="Your own runner uses your local git credentials and does not need this."
          placeholder="ghp_…"
          handle={handle('GIT_TOKEN')}
        />
      </SettingSection>

      {/* Verification commands used to be here and are now on each module,
          beside the repository and paths they belong to. Said out loud, so
          somebody who remembers this page having them is not left hunting. */}
      <SettingSection
        title="How to verify the work"
        description="Set per module, not here. The commands that check a change depend on the code, so they live on the module that owns it — beside the repository and the paths it covers."
      >
        <p className="text-muted-foreground">
          Open a module and look for{' '}
          <span className="text-foreground">How to verify the work</span>. An
          issue that names that module hands its run those commands.
        </p>
        <div>
          <Button variant="secondary" size="sm" asChild>
            <NextLink href={workspaceHref(workspaceSlug, 'modules')}>
              Go to modules
            </NextLink>
          </Button>
        </div>
      </SettingSection>

      <SettingSection
        title="Agent accounts"
        description="Identities that act inside this workspace. Their edits are attributed to them, not to whoever provisioned them."
      >
        {isLoading && <Loader />}

        {!isLoading && active.length === 0 && (
          <p className="text-muted-foreground">
            No active agents in this workspace.
          </p>
        )}

        {active.map((agent: AgentSummary) => (
          <AgentItem key={agent.id} agent={agent} workspaceId={workspace.id} />
        ))}

        {revoked.length > 0 && (
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRevoked(!showRevoked)}
              >
                {showRevoked ? 'Hide' : 'Show'} {revoked.length} revoked
              </Button>

              {/* Removes the rows, not the accounts. These agents authored
                  issues and comments, and deleting them would break attribution
                  on records that still name them. */}
              <Button
                variant="ghost"
                size="sm"
                isLoading={isClearing}
                onClick={() => clearRevoked({ workspaceId: workspace.id })}
              >
                Clear them
              </Button>
            </div>

            {showRevoked &&
              revoked.map((agent: AgentSummary) => (
                <AgentItem
                  key={agent.id}
                  agent={agent}
                  workspaceId={workspace.id}
                />
              ))}
          </div>
        )}
      </SettingSection>
    </div>
  );
});
