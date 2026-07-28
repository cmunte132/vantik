import type { LocalRepository, RepositoryFolder } from '@vantikhq/types';

import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from '@tanstack/react-query';
import {
  addLocalRepository,
  getLocalRepositories,
  getLocalRepositoryFolders,
  removeLocalRepository,
} from '@vantikhq/services';

import { type XHRErrorResponse } from 'services/utils';

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

interface MutationParams<T> {
  onSuccess?: (data: T) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError?: (error: any) => void;
}

export function useAddLocalRepositoryMutation({
  onSuccess,
  onError,
}: MutationParams<LocalRepository> = {}) {
  return useMutation({
    mutationFn: addLocalRepository,
    onSuccess: (data) => onSuccess && onSuccess(data),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (error: any) => onError && onError(error),
  });
}

export function useRemoveLocalRepositoryMutation({
  onSuccess,
  onError,
}: MutationParams<LocalRepository> = {}) {
  return useMutation({
    mutationFn: removeLocalRepository,
    onSuccess: (data) => onSuccess && onSuccess(data),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (error: any) => onError && onError(error),
  });
}
