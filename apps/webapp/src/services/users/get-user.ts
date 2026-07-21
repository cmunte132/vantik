import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import type { User } from 'common/types';

import { type XHRErrorResponse, ajaxGet } from 'services/utils';

/**
 * Query Key for Get user.
 */
export const GetUserQuery = 'getUserQuery';

export function getUser() {
  return ajaxGet<User>({
    url: '/api/v1/users',
  });
}

export function useGetUserQuery(): UseQueryResult<User, XHRErrorResponse> {
  return useQuery({
    queryKey: [GetUserQuery],
    queryFn: () => getUser(),
    retry: 1,
    staleTime: Infinity,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false,
  });
}
