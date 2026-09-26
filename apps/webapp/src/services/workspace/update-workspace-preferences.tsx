import type { UpdateWorkspacePreferencesDto } from '@vantikhq/types';

import type { WorkspaceType } from 'common/types';

import { GetUserQuery } from 'services/users';
import { ajaxPost, mutationHook } from 'services/utils';

export function updateWorkspacePreferences(
  updateData: UpdateWorkspacePreferencesDto,
): Promise<WorkspaceType> {
  return ajaxPost({ url: `/api/v1/workspaces/preferences`, data: updateData });
}

export const useUpdateWorkspacePreferencesMutation = mutationHook(
  updateWorkspacePreferences,
  { invalidates: [GetUserQuery] },
);
