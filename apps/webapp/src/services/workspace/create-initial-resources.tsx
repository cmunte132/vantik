import type { WorkspaceType } from 'common/types';

import { GetUserQuery } from 'services/users';
import { ajaxPost, mutationHook } from 'services/utils';

export interface CreateInitialResourcesDto {
  workspaceName: string;
  fullname: string;
  teamName: string;
  teamIdentifier: string;
}

export function createInitialResources(
  createInitialResourcesDto: CreateInitialResourcesDto,
): Promise<WorkspaceType> {
  return ajaxPost({
    url: `/api/v1/workspaces/onboarding`,
    data: createInitialResourcesDto,
  });
}

export const useCreateInitialResourcesMutation = mutationHook(
  createInitialResources,
  { invalidates: [GetUserQuery] },
);
