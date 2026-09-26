import { ajaxDelete, mutationHook } from 'services/utils';

export interface DeleteIssueParams {
  issueId: string;
  teamId: string;
}

export function deleteIssue({ issueId, teamId }: DeleteIssueParams) {
  return ajaxDelete({
    url: `/api/v1/issues/${issueId}?teamId=${teamId}`,
  });
}

export const useDeleteIssueMutation = mutationHook(deleteIssue);
