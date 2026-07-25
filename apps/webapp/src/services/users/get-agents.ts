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
): UseQueryResult<AgentSummary[], XHRErrorResponse> {
  return useQuery({
    // Keyed by workspace, so switching workspaces does not read the previous
    // one's agents out of the cache.
    queryKey: [GetAgents, workspaceId],
    queryFn: () => getAgents(workspaceId),
    enabled: enabled && Boolean(workspaceId),
    retry: 1,
    staleTime: 1,
    refetchOnWindowFocus: false,
  });
}
