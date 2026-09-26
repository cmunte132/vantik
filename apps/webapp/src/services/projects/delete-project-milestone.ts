import type { Project } from '@vantikhq/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteProjectMilestone(
  projectMilestoneId: string,
): Promise<Project> {
  return ajaxDelete({
    url: `/api/v1/projects/milestone/${projectMilestoneId}`,
  });
}

export const useDeleteProjectMilestoneMutation = mutationHook(
  deleteProjectMilestone,
);
