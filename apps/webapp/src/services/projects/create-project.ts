import type { CreateProjectDto, Project } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createProject(
  createProjectDto: CreateProjectDto,
): Promise<Project> {
  return ajaxPost({ url: `/api/v1/projects`, data: createProjectDto });
}

export const useCreateProjectMutation = mutationHook(createProject);
