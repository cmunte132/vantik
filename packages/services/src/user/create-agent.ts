import { AgentAccount, AgentScope } from '@vantikhq/types';
import axios from 'axios';

export interface CreateAgentDto {
  name: string;
  /** What the agent may do. Omit for the default: read and write, not delete. */
  scopes?: AgentScope[];
}

export async function createAgent(
  createAgentDto: CreateAgentDto,
): Promise<AgentAccount> {
  const response = await axios.post(`/api/v1/users/agents`, createAgentDto);

  return response.data;
}
