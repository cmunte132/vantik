import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import type { IssueType } from 'common/types';

import { type XHRErrorResponse, ajaxGet } from 'services/utils';

/**
 * Query Key for Searching Issues.
 */
export const SimilarIssuesQuery = 'similarIssuesQuery';

export interface SimilarIssuesParams {
  workspaceId: string;
  issueId: string;
  limit?: number;
}

export function similarIssues(data: SimilarIssuesParams) {
  return ajaxGet<IssueType[]>({
    url: `/api/v1/search/similar_issues`,
    query: {
      limit: 3,
      ...data,
    },
  });
}

export function useGetSimilarIssuesQuery(
  data: SimilarIssuesParams,
  enabled = false,
): UseQueryResult<IssueType[], XHRErrorResponse> {
  return useQuery({
    queryKey: [SimilarIssuesQuery, data.issueId],
    queryFn: () => similarIssues(data),
    retry: 1,
    staleTime: 1,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false,

    enabled,
  });
}
