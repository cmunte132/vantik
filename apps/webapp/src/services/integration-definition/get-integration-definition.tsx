import type { IntegrationDefinition } from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { getIntegrationDefinition } from '@vantikhq/services';

import { type XHRErrorResponse } from 'services/utils';

/**
 * Query Key for Get user.
 */
const GetIntegrationDefinition = 'getIntegrationDefinition';

export function useGetIntegrationDefinition(
  integrationDefinitionId: string,
): UseQueryResult<IntegrationDefinition, XHRErrorResponse> {
  return useQuery({
    queryKey: [GetIntegrationDefinition, integrationDefinitionId],
    queryFn: () => getIntegrationDefinition({ integrationDefinitionId }),
    retry: 1,
    staleTime: 1000000,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false,
  });
}
