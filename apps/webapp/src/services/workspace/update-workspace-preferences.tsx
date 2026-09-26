import { updateWorkspacePreferences } from '@vantikhq/services';

import { GetUserQuery } from 'services/users';
import { mutationHook } from 'services/utils';

export const useUpdateWorkspacePreferencesMutation = mutationHook(
  updateWorkspacePreferences,
  { invalidates: [GetUserQuery] },
);
