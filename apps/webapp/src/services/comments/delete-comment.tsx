import type { IssueCommentRequestParamsDto } from '@vantikhq/types';

import type { IssueCommentType } from 'common/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteIssueComment({
  issueCommentId,
}: IssueCommentRequestParamsDto): Promise<IssueCommentType> {
  return ajaxDelete({ url: `/api/v1/issue_comments/${issueCommentId}` });
}

export const useDeleteCommentMutation = mutationHook(deleteIssueComment);
