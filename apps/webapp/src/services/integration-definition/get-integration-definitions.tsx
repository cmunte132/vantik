import type { IntegrationDefinition } from '@vantikhq/types';

import { getIntegrationDefinitions } from '@vantikhq/services';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { type XHRErrorResponse } from 'services/utils';

/**
 * Query Key for Get user.
 */
const GetIntegrationDefinitions = 'getIntegrationDefinitions';

export function useGetIntegrationDefinitions(
  workspaceId: string,
): UseQueryResult<IntegrationDefinition[], XHRErrorResponse> {
  return useQuery({
    queryKey: [GetIntegrationDefinitions, workspaceId],
    queryFn: () => getIntegrationDefinitions({ workspaceId }),
    retry: 1,
    staleTime: 100000,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false
  });
}
