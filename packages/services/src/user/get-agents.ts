import { AgentSummary } from '@vantikhq/types';
import axios from 'axios';

export async function getAgents(): Promise<AgentSummary[]> {
  const response = await axios.get(`/api/v1/users/agents`);

  return response.data;
}
