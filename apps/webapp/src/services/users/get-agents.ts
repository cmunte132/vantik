import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { getAgents } from '@vantikhq/services';
import { type AgentSummary } from '@vantikhq/types';

import { type XHRErrorResponse } from 'services/utils';

/**
 * Query key for the workspace's agent accounts.
 */
export const GetAgents = 'getAgents';

export function useGetAgentsQuery(): UseQueryResult<
  AgentSummary[],
  XHRErrorResponse
> {
  return useQuery({
    queryKey: [GetAgents],
    queryFn: () => getAgents(),
    retry: 1,
    staleTime: 1,
    refetchOnWindowFocus: false,
  });
}
