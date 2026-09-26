import type { WorkspaceType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface UpdateWorkspaceParams {
  name: string;
}

export function updateWorkspace({
  name,
}: UpdateWorkspaceParams): Promise<WorkspaceType> {
  return ajaxPost({
    url: `/api/v1/workspaces`,
    data: { name },
  });
}

export const useUpdateWorkspaceMutation = mutationHook(updateWorkspace);
