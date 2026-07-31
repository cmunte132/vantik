import { AgentSummary } from '@vantikhq/types';
import axios from 'axios';

/**
 * The workspace's agent accounts.
 *
 * `mine` is the account-settings view — the agents you own, readable by any
 * member. `all` is the admin view of everything operating in the workspace.
 */
export async function getAgents(
  workspaceId: string,
  scope: 'mine' | 'all' = 'all',
): Promise<AgentSummary[]> {
  const response = await axios.get(
    `/api/v1/users/agents?workspaceId=${workspaceId}&scope=${scope}`,
  );

  return response.data;
}
