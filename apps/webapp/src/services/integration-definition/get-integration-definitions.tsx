import type {
  IntegrationDefinition,
  WorkspaceRequestParamsDto,
} from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { ajaxGet, type XHRErrorResponse } from 'services/utils';

export function getIntegrationDefinitions({
  workspaceId,
}: WorkspaceRequestParamsDto): Promise<IntegrationDefinition[]> {
  return ajaxGet({
    url: `/api/v1/integration_definition?workspaceId=${workspaceId}`,
  });
}

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
    refetchOnWindowFocus: false,
  });
}
