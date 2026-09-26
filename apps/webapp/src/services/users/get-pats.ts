import type { Pat } from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { ajaxGet, type XHRErrorResponse } from 'services/utils';

export function getPats(): Promise<Pat[]> {
  return ajaxGet({ url: `/api/v1/users/pats` });
}

/**
 * Query Key for Get user.
 */
export const GetPats = 'getPats';

export function useGetPatsQuery(): UseQueryResult<Pat[], XHRErrorResponse> {
  return useQuery({
    queryKey: [GetPats],
    queryFn: () => getPats(),
    retry: 1,
    staleTime: 1,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false,
  });
}
