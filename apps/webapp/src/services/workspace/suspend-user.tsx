import type { WorkspaceType } from 'common/types';

import { GetUserQuery } from 'services/users';
import { ajaxPost, mutationHook } from 'services/utils';

export function suspendUser(updateData: {
  userId: string;
}): Promise<WorkspaceType> {
  return ajaxPost({ url: `/api/v1/workspaces/suspend`, data: updateData });
}

export const useSuspendUserMutation = mutationHook(suspendUser, {
  invalidates: [GetUserQuery],
});
