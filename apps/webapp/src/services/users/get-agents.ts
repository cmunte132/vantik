import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { getAgents } from '@vantikhq/services';
import { type AgentSummary } from '@vantikhq/types';

import { type XHRErrorResponse } from 'services/utils';

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
