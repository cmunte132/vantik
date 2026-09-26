import type { CreateTeamDto, Team } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createTeam(teamData: CreateTeamDto): Promise<Team> {
  return ajaxPost({ url: `/api/v1/teams`, data: teamData });
}

export const useCreateTeamMutation = mutationHook(createTeam);
