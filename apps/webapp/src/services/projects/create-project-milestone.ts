import type { CreateProjectMilestoneDto } from '@vantikhq/types';

import type { ProjectMilestoneType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface CreateProjectMilestoneWithProjectDto extends CreateProjectMilestoneDto {
  projectId: string;
}

export function createProjectMilestone({
  projectId,
  ...createProjectMilestoneDto
}: CreateProjectMilestoneWithProjectDto): Promise<ProjectMilestoneType> {
  return ajaxPost({
    url: `/api/v1/projects/${projectId}/milestone`,
    data: createProjectMilestoneDto,
  });
}

export const useCreateProjectMilestoneMutation = mutationHook(
  createProjectMilestone,
);
