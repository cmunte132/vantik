import type { Pat } from '@vantikhq/types';

import { getPats } from '@vantikhq/services';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { type XHRErrorResponse } from 'services/utils';

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
    refetchOnWindowFocus: false
  });
}
