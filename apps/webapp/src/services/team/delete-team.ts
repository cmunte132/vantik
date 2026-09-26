import type { TeamRequestParamsDto } from '@vantikhq/types';

import type { TeamType } from 'common/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteTeam({
  teamId,
}: TeamRequestParamsDto): Promise<TeamType> {
  return ajaxDelete({ url: `/api/v1/teams/${teamId}` });
}

export const useDeleteTeamMutation = mutationHook(deleteTeam);
