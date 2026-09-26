import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type AgentSummary } from '@vantikhq/types';

import { ajaxGet, type XHRErrorResponse } from 'services/utils';

/**
 * The workspace's agent accounts.
 *
 * `mine` is the account-settings view — the agents you own, readable by any
 * member. `all` is the admin view of everything operating in the workspace.
 */
export function getAgents(
  workspaceId: string,
  scope: 'mine' | 'all' = 'all',
): Promise<AgentSummary[]> {
  return ajaxGet({
    url: `/api/v1/users/agents?workspaceId=${workspaceId}&scope=${scope}`,
  });
}

/**
 * Query key for the workspace's agent accounts.
 */
export const GetAgents = 'getAgents';

export function useGetAgentsQuery(
  workspaceId: string,
  enabled = true,
  scope: 'mine' | 'all' = 'all',
): UseQueryResult<AgentSummary[], XHRErrorResponse> {
  return useQuery({
    // Keyed by workspace *and scope*, so the personal screen and the admin
    // screen do not read each other's results out of the cache — they return
    // different sets, and one showing the other's would be a disclosure.
    queryKey: [GetAgents, workspaceId, scope],
    queryFn: () => getAgents(workspaceId, scope),
    enabled: enabled && Boolean(workspaceId),
    retry: 1,
    staleTime: 1,
    refetchOnWindowFocus: false,
  });
}
