import type {
  ProjectMilestone,
  UpdateProjectMilestoneDto,
} from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateProjectMilestoneWithProjectDto extends UpdateProjectMilestoneDto {
  projectMilestoneId: string;
}

export function updateProjectMilestone({
  projectMilestoneId,
  ...updateProjecMilestonetDto
}: UpdateProjectMilestoneWithProjectDto): Promise<ProjectMilestone> {
  return ajaxPost({
    url: `/api/v1/projects/milestone/${projectMilestoneId}`,
    data: updateProjecMilestonetDto,
  });
}

export const useUpdateProjectMilestoneMutation = mutationHook(
  updateProjectMilestone,
);
