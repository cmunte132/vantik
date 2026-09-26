import { updateTeamPreferences } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useUpdateTeamPreferencesMutation = mutationHook(
  updateTeamPreferences,
);
