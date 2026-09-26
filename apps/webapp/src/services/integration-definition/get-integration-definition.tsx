import type {
  IntegrationDefinition,
  IntegrationDefinitionIdDto,
} from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { ajaxGet, type XHRErrorResponse } from 'services/utils';

export function getIntegrationDefinition({
  integrationDefinitionId,
}: IntegrationDefinitionIdDto): Promise<IntegrationDefinition> {
  return ajaxGet({
    url: `/api/v1/integration_definition/${integrationDefinitionId}`,
  });
}

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
