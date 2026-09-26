import { ajaxPost, mutationHook } from 'services/utils';

interface RemoveTeamMemberDto {
  userId: string;
  teamId: string;
}

export function removeTeamMember({ teamId, userId }: RemoveTeamMemberDto) {
  return ajaxPost({
    url: `/api/v1/teams/${teamId}/remove-member`,
    data: {
      userId,
    },
  });
}

export const useRemoveTeamMemberMutation = mutationHook(removeTeamMember);
