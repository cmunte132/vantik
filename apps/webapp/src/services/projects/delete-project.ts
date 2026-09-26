import type { Project } from '@vantikhq/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteProject(projectId: string): Promise<Project> {
  return ajaxDelete({ url: `/api/v1/projects/${projectId}` });
}

export const useDeleteProjectMutation = mutationHook(deleteProject);
