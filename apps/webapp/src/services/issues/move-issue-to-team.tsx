import type { IssueType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface MoveIssueToTeamParams {
  teamId: string;
  issueId: string;
}

export function moveIssueToTeam({
  issueId,
  teamId,
}: MoveIssueToTeamParams): Promise<IssueType> {
  return ajaxPost({
    url: `/api/v1/issues/${issueId}/move`,
    data: {
      teamId,
    },
  });
}

export const useMoveIssueToTeamMutation = mutationHook(moveIssueToTeam);
