import type { LocalRepository } from '@vantikhq/types';

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

export const GetLocalRepositories = 'getLocalRepositories';

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

export const useAddLocalRepositoryMutation = mutationHook(addLocalRepository, {
  fallback: 'The server refused this path, and it gave no reason.',
});

export const useRemoveLocalRepositoryMutation = mutationHook(
  removeLocalRepository,
);
