import { ajaxPost, mutationHook } from 'services/utils';

export interface AITitleParams {
  description: string;
  workspaceId: string;
}

export function aiTitleIssues({
  description,
  workspaceId,
}: AITitleParams): Promise<string> {
  return ajaxPost({
    url: `/api/v1/issues/ai/ai_title`,
    data: {
      description,
      workspaceId,
    },
  });
}

export const useAITitleMutation = mutationHook(aiTitleIssues);
