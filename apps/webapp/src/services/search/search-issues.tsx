import {
  type UseQueryResult,
  keepPreviousData,
  useQuery,
} from '@tanstack/react-query';

import type { IssueType } from 'common/types';

import { type XHRErrorResponse, ajaxGet } from 'services/utils';

/**
 * Query Key for Searching Issues.
 */
export const SearchIssuesQuery = 'searchUserQuery';

export interface SearchIssuesParams {
  workspaceId: string;
  query: string;
  limit?: number;
  threshold?: number;
}

export function searchIssue(data: SearchIssuesParams) {
  return ajaxGet<IssueType[]>({
    url: `/api/v1/search`,
    query: {
      limit: 10,
      ...data,
    },
  });
}

export function useGetSearchIssuesQuery(
  data: SearchIssuesParams,
  enabled = false,
): UseQueryResult<IssueType[], XHRErrorResponse> {
  return useQuery({
    queryKey: [SearchIssuesQuery, data.query],
    queryFn: () => searchIssue(data),
    retry: 1,
    staleTime: 1,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false,

    enabled,
    placeholderData: keepPreviousData,
  });
}
