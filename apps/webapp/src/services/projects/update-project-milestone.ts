import type { UpdateProjectMilestoneDto } from '@vantikhq/types';

import type { ProjectMilestoneType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateProjectMilestoneWithProjectDto extends UpdateProjectMilestoneDto {
  projectMilestoneId: string;
}

export function updateProjectMilestone({
  projectMilestoneId,
  ...updateProjecMilestonetDto
}: UpdateProjectMilestoneWithProjectDto): Promise<ProjectMilestoneType> {
  return ajaxPost({
    url: `/api/v1/projects/milestone/${projectMilestoneId}`,
    data: updateProjecMilestonetDto,
  });
}

export const useUpdateProjectMilestoneMutation = mutationHook(
  updateProjectMilestone,
);
