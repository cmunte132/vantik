import { createTeam } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useCreateTeamMutation = mutationHook(createTeam);
