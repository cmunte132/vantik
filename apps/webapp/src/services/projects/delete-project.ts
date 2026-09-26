import type { ProjectType } from 'common/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteProject(projectId: string): Promise<ProjectType> {
  return ajaxDelete({ url: `/api/v1/projects/${projectId}` });
}

export const useDeleteProjectMutation = mutationHook(deleteProject);
