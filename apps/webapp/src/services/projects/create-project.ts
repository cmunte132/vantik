import type { CreateProjectDto } from '@vantikhq/types';

import type { ProjectType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createProject(
  createProjectDto: CreateProjectDto,
): Promise<ProjectType> {
  return ajaxPost({ url: `/api/v1/projects`, data: createProjectDto });
}

export const useCreateProjectMutation = mutationHook(createProject);
