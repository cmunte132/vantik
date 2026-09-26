import type { IssueCommentType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface CreateIssueCommentParams {
  body: string;
  issueId: string;
  parentId?: string;
}

export function createIssueComment({
  issueId,
  body,
  parentId,
}: CreateIssueCommentParams): Promise<IssueCommentType> {
  return ajaxPost({
    url: `/api/v1/issue_comments?issueId=${issueId}`,
    data: { body, parentId },
  });
}

export const useCreateIssueCommentMutation = mutationHook(createIssueComment);
