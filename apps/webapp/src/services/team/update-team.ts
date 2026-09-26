import { updateTeam, type UpdateTeamDtoWithTeamId } from '@vantikhq/services';

import type { TeamType } from 'common/types';

import { type MutationCallbacks, useApiMutation } from 'services/utils';

import { useContextStore } from 'store/global-context-provider';

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
