import { ajaxPost, mutationHook } from 'services/utils';

import { GetAgents } from './get-agents';

export interface RevokeAgentDto {
  agentId: string;
  workspaceId: string;
}

export function revokeAgent({
  agentId,
  workspaceId,
}: RevokeAgentDto): Promise<void> {
  return ajaxPost({
    url: `/api/v1/users/agents/${agentId}/revoke?workspaceId=${workspaceId}`,
  });
}

export const useRevokeAgentMutation = mutationHook(revokeAgent, {
  invalidates: [GetAgents],
});
