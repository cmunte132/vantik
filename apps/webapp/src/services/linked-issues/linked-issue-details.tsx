import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { type XHRErrorResponse, ajaxGet } from 'services/utils';

export const GetLinkedIssueDetailsQuery = 'getLinkedIssueDetailsQuery';

interface LinkedIssueDetails {
  status: string;
  events: string;
  lastSeen: string;
  seenByUser: boolean;
  priority: string;
}

export function getLinkedIssueDetails(linkedIssueId: string) {
  return ajaxGet<LinkedIssueDetails>({
    url: `/api/v1/linked_issues/${linkedIssueId}/details`,
  });
}

export function useGetLinkedIssueDetailsQuery(
  linkedIssueId: string,
): UseQueryResult<LinkedIssueDetails, XHRErrorResponse> {
  return useQuery({
    queryKey: [GetLinkedIssueDetailsQuery, linkedIssueId],
    queryFn: () => getLinkedIssueDetails(linkedIssueId),
    retry: 1,
    staleTime: 1,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false
  });
}
