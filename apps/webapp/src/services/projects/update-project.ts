import type { Project, UpdateProjectDto } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateProjectWithProjectDto extends UpdateProjectDto {
  projectId: string;
}

export function updateProject({
  projectId,
  ...updateProjectDto
}: UpdateProjectWithProjectDto): Promise<Project> {
  return ajaxPost({
    url: `/api/v1/projects/${projectId}`,
    data: updateProjectDto,
  });
}

export const useUpdateProjectMutation = mutationHook(updateProject);
