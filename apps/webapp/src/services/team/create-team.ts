import type { CreateTeamDto } from '@vantikhq/types';

import type { TeamType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createTeam(teamData: CreateTeamDto): Promise<TeamType> {
  return ajaxPost({ url: `/api/v1/teams`, data: teamData });
}

export const useCreateTeamMutation = mutationHook(createTeam);
