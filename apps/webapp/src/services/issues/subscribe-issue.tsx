import type { SubscribeType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface UpdateIssueSubscribeParams {
  type: SubscribeType;
  issueId: string;
}

export function updateIssueSubscribe({
  issueId,
  type,
}: UpdateIssueSubscribeParams) {
  return ajaxPost({
    url: `/api/v1/issues/${issueId}/subscribe`,
    data: {
      type,
    },
  });
}

export const useUpdateIssueSubscribeMutation =
  mutationHook(updateIssueSubscribe);
