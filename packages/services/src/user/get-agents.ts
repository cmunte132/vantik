import { AgentSummary } from '@vantikhq/types';
import axios from 'axios';

export async function getAgents(workspaceId: string): Promise<AgentSummary[]> {
  const response = await axios.get(
    `/api/v1/users/agents?workspaceId=${workspaceId}`,
  );

  return response.data;
}
