import type { ActionConfig } from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { type XHRErrorResponse, ajaxGet } from 'services/utils';

/**
 * Query Key for Get user.
 */
const GetExternalActionData = 'getExternalActionData';

export function getExternalActionData(actionSlug: string) {
  return ajaxGet<ActionConfig>({
    url: `/api/v1/action/external/${actionSlug}`,
  });
}

export function useGetExternalActionDataQuery(
  actionSlug: string,
): UseQueryResult<ActionConfig, XHRErrorResponse> {
  return useQuery({
    queryKey: [GetExternalActionData, actionSlug],
    queryFn: () => getExternalActionData(actionSlug),
    retry: 1,
    staleTime: 10000,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false
  });
}
