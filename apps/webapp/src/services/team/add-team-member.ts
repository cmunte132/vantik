import type { AddTeamMemberDto } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function addTeamMember({ teamId, userId }: AddTeamMemberDto) {
  return ajaxPost({
    url: `/api/v1/teams/${teamId}/add-member`,
    data: {
      userId,
    },
  });
}

export const useAddTeamMemberMutation = mutationHook(addTeamMember);
