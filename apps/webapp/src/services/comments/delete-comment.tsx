import type { Issue, IssueCommentRequestParamsDto } from '@vantikhq/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteIssueComment({
  issueCommentId,
}: IssueCommentRequestParamsDto): Promise<Issue> {
  return ajaxDelete({ url: `/api/v1/issue_comments/${issueCommentId}` });
}

export const useDeleteCommentMutation = mutationHook(deleteIssueComment);
