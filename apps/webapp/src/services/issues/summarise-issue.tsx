import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { type XHRErrorResponse, ajaxGet } from 'services/utils';

/**
 * Query Key for Get user.
 */
export const SummarizeIssue = 'summarizeIssue';

export function getSummarizeIssue(issueId: string) {
  return ajaxGet<string[]>({
    url: `/api/v1/issues/ai/${issueId}/summarize`,
  });
}

export function useSummarizeIssue(
  issueId: string,
): UseQueryResult<string[], XHRErrorResponse> {
  return useQuery({
    queryKey: [SummarizeIssue],
    queryFn: () => getSummarizeIssue(issueId),
    retry: 1,
    staleTime: 1,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false
  });
}
