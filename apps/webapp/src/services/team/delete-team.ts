import { deleteTeam } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useDeleteTeamMutation = mutationHook(deleteTeam);
