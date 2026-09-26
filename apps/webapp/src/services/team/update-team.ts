import type { UpdateTeamDto } from '@vantikhq/types';

import type { TeamType } from 'common/types';

import {
  ajaxPost,
  type MutationCallbacks,
  useApiMutation,
} from 'services/utils';

import { useContextStore } from 'store/global-context-provider';

export interface UpdateTeamDtoWithTeamId extends UpdateTeamDto {
  teamId: string;
}

export function updateTeam({
  teamId,
  ...updateData
}: UpdateTeamDtoWithTeamId): Promise<TeamType> {
  return ajaxPost({ url: `/api/v1/teams/${teamId}`, data: updateData });
}

export function useUpdateTeamMutation(
  callbacks: MutationCallbacks<TeamType, UpdateTeamDtoWithTeamId> = {},
) {
  const { teamsStore } = useContextStore();

  const update = async ({
    teamId,
    ...otherParams
  }: UpdateTeamDtoWithTeamId): Promise<TeamType> => {
    const team = teamsStore.getTeamWithId(teamId);

    try {
      teamsStore.update({ ...otherParams, preferences: {} }, team.id);
      return updateTeam({ ...otherParams, teamId });
    } catch (e) {
      teamsStore.update(team, team.id);
      return undefined;
    }
  };

  return useApiMutation(update, callbacks);
}
