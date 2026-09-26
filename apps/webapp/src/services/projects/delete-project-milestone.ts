import type { ProjectType } from 'common/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteProjectMilestone(
  projectMilestoneId: string,
): Promise<ProjectType> {
  return ajaxDelete({
    url: `/api/v1/projects/milestone/${projectMilestoneId}`,
  });
}

export const useDeleteProjectMilestoneMutation = mutationHook(
  deleteProjectMilestone,
);
