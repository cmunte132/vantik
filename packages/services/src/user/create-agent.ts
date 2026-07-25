import { AgentAccount, AgentScope } from '@vantikhq/types';
import axios from 'axios';

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

export async function createAgent({
  workspaceId,
  ...createAgentDto
}: CreateAgentDto): Promise<AgentAccount> {
  const response = await axios.post(
    `/api/v1/users/agents?workspaceId=${workspaceId}`,
    createAgentDto,
  );

  return response.data;
}
