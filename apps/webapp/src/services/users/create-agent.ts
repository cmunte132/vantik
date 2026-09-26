import type { AgentAccount, AgentScope } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

import { GetAgents } from './get-agents';

export interface CreateAgentDto {
  name: string;
  /** What the agent may do. Omit for the default: read and write, not delete. */
  scopes?: AgentScope[];
  /**
   * The workspace to provision into. Named explicitly because the server would
   * otherwise fall back to the one on the access token, which is the account's
   * first workspace rather than the one being looked at.
   */
  workspaceId: string;
}

export function createAgent({
  workspaceId,
  ...createAgentDto
}: CreateAgentDto): Promise<AgentAccount> {
  return ajaxPost({
    url: `/api/v1/users/agents?workspaceId=${workspaceId}`,
    data: createAgentDto,
  });
}

export const useCreateAgentMutation = mutationHook(createAgent, {
  invalidates: [GetAgents],
});
