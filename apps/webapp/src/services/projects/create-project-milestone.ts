import type {
  CreateProjectMilestoneDto,
  ProjectMilestone,
} from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface CreateProjectMilestoneWithProjectDto extends CreateProjectMilestoneDto {
  projectId: string;
}

export function createProjectMilestone({
  projectId,
  ...createProjectMilestoneDto
}: CreateProjectMilestoneWithProjectDto): Promise<ProjectMilestone> {
  return ajaxPost({
    url: `/api/v1/projects/${projectId}/milestone`,
    data: createProjectMilestoneDto,
  });
}

export const useCreateProjectMilestoneMutation = mutationHook(
  createProjectMilestone,
);
