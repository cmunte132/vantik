import type { UpdateTeamPreferencesDto } from '@vantikhq/types';

import type { TeamType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface UpdateTeamPreferencesDtoWithTeamId extends UpdateTeamPreferencesDto {
  teamId: string;
}

export function updateTeamPreferences({
  teamId,
  ...updateData
}: UpdateTeamPreferencesDtoWithTeamId): Promise<TeamType> {
  return ajaxPost({
    url: `/api/v1/teams/${teamId}/preferences`,
    data: updateData,
  });
}

export const useUpdateTeamPreferencesMutation = mutationHook(
  updateTeamPreferences,
);
