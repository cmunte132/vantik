import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import type { User } from 'common/types';

import { type XHRErrorResponse, ajaxGet } from 'services/utils';

/**
 * Query Key for Get user.
 */
export const GetSignedURL = 'getSignedURLQuery';

export function getSignedURL(attachmentId: string) {
  return ajaxGet<User>({
    url: `/api/v1/attachment/get-signed-url/${attachmentId}`,
  });
}

export function useGetSignedURLQuery(
  attachmentId: string,
): UseQueryResult<User, XHRErrorResponse> {
  return useQuery({
    queryKey: [GetSignedURL],
    queryFn: () => getSignedURL(attachmentId),
    retry: 1,
    staleTime: Infinity,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false,
  });
}
