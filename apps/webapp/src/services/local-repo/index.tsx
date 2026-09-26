import type { LocalRepository, RepositoryFolder } from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import {
  addLocalRepository,
  getLocalRepositories,
  getLocalRepositoryFolders,
  removeLocalRepository,
} from '@vantikhq/services';

import { mutationHook, type XHRErrorResponse } from 'services/utils';

export const GetLocalRepositories = 'getLocalRepositories';
export const GetLocalRepositoryFolders = 'getLocalRepositoryFolders';

export function useGetLocalRepositories(): UseQueryResult<
  LocalRepository[],
  XHRErrorResponse
> {
  return useQuery({
    queryKey: [GetLocalRepositories],
    queryFn: () => getLocalRepositories(),
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/**
 * The folders of one repository.
 *
 * The server reads the disk for this answer, so the caller asks for it only
 * when somebody opens the picker. The answer describes the repository and not
 * the module, and every module that connects the repository shares it.
 */
export function useGetLocalRepositoryFolders(
  repositoryId: string | undefined,
  enabled: boolean,
): UseQueryResult<RepositoryFolder[], XHRErrorResponse> {
  return useQuery({
    queryKey: [GetLocalRepositoryFolders, repositoryId],
    queryFn: () => getLocalRepositoryFolders({ repositoryId }),
    enabled: enabled && Boolean(repositoryId),
    retry: 1,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
}

export const useAddLocalRepositoryMutation = mutationHook(addLocalRepository, {
  fallback: 'The server refused this path, and it gave no reason.',
});

export const useRemoveLocalRepositoryMutation = mutationHook(
  removeLocalRepository,
);
