import { ajaxPost, mutationHook } from 'services/utils';

export interface SubIssueGenerationParams {
  description: string;
  workspaceId: string;
}

export function aiSubIssueGeneration({
  description,
  workspaceId,
}: SubIssueGenerationParams): Promise<string[]> {
  return ajaxPost({
    url: `/api/v1/issues/ai/subissues/generate`,
    data: {
      description,
      workspaceId,
      labelIds: [],
    },
  });
}

export const useSubIssueGenerationMutation = mutationHook(aiSubIssueGeneration);
