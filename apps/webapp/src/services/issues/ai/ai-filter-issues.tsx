import type { IssueType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface AIFilterIssuesParams {
  text: string;
  teamId?: string;
  workspaceId: string;
}

export function aiFilterIssues(data: AIFilterIssuesParams): Promise<IssueType> {
  return ajaxPost({
    url: `/api/v1/issues/ai/ai_filters`,
    data,
  });
}

export const useAIFilterIssuesMutation = mutationHook(aiFilterIssues);
