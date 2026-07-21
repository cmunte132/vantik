import type { ActionConfig } from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { type XHRErrorResponse, ajaxGet } from 'services/utils';

export interface ActionExternalConfig extends ActionConfig {
  version: string;
}

/**
 * Query Key for Get user.
 */
const GetAllActions = 'getAllActions';

export function getAllActions() {
  return ajaxGet<ActionExternalConfig[]>({
    url: '/api/v1/action/external',
  });
}

export function useGetAllActionsQuery(): UseQueryResult<
  ActionExternalConfig[],
  XHRErrorResponse
> {
  return useQuery({
    queryKey: [GetAllActions],
    queryFn: () => getAllActions(),
    retry: 1,
    staleTime: 1,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false,
  });
}
