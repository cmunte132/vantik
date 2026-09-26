import type { IssueCommentType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface UpdateIssueCommentParams {
  body: string;
  parentId?: string;
  issueCommentId: string;
}

export function updateIssueComment({
  issueCommentId,
  body,
  parentId,
}: UpdateIssueCommentParams): Promise<IssueCommentType> {
  return ajaxPost({
    url: `/api/v1/issue_comments/${issueCommentId}`,
    data: { body, parentId },
  });
}

export const useUpdateIssueCommentMutation = mutationHook(updateIssueComment);
