import type { LocalRepository, RepositoryFolder } from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import {
  ajaxDelete,
  ajaxGet,
  ajaxPost,
  mutationHook,
  type XHRErrorResponse,
} from 'services/utils';

/**
 * The repositories that this workspace has on the disk of the server.
 *
 * These rows live in the `settings` of an integration account, so a write
 * arrives back over the socket as a sync action on that account. The caller
 * needs no refetch after a write.
 */
export function getLocalRepositories(): Promise<LocalRepository[]> {
  return ajaxGet({ url: '/api/v1/local_repo' });
}

export function addLocalRepository({
  path,
}: {
  path: string;
}): Promise<LocalRepository> {
  return ajaxPost({ url: '/api/v1/local_repo', data: { path } });
}

export function removeLocalRepository({
  repositoryId,
}: {
  repositoryId: string;
}): Promise<LocalRepository> {
  return ajaxDelete({ url: `/api/v1/local_repo/${repositoryId}` });
}

/**
 * The folders inside one repository that a module can claim.
 *
 * This answer describes the repository, and the repository belongs to the
 * workspace. Each module that connects the same repository reads the same
 * folders, and each one keeps its own choice among them.
 */
export function getLocalRepositoryFolders({
  repositoryId,
}: {
  repositoryId: string;
}): Promise<RepositoryFolder[]> {
  return ajaxGet({ url: `/api/v1/local_repo/${repositoryId}/folders` });
}

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
