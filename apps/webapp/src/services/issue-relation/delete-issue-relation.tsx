import { ajaxDelete, mutationHook } from 'services/utils';

export interface DeleteIssueRelationParams {
  issueRelationId: string;
}

export function deleteIssueRelation({
  issueRelationId,
}: DeleteIssueRelationParams) {
  return ajaxDelete({
    url: `/api/v1/issue_relation/${issueRelationId}`,
  });
}

export const useDeleteIssueRelationMutation = mutationHook(deleteIssueRelation);
