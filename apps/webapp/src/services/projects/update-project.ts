import type { UpdateProjectDto } from '@vantikhq/types';

import type { ProjectType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateProjectWithProjectDto extends UpdateProjectDto {
  projectId: string;
}

export function updateProject({
  projectId,
  ...updateProjectDto
}: UpdateProjectWithProjectDto): Promise<ProjectType> {
  return ajaxPost({
    url: `/api/v1/projects/${projectId}`,
    data: updateProjectDto,
  });
}

export const useUpdateProjectMutation = mutationHook(updateProject);
