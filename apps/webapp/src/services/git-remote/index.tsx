import type {
  AvailableGitRemoteRepository,
  GitRemoteConnection,
  GitRemoteKind,
  GitRemoteRepository,
} from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import {
  ajaxDelete,
  ajaxGet,
  ajaxPost,
  mutationHook,
  type XHRErrorResponse,
} from 'services/utils';

/**
 * The git hosts that this workspace connected, and their repositories.
 *
 * No response holds a token. A connection says only whether it has a token,
 * and the last characters of a long one.
 */
export function getGitRemotes(): Promise<GitRemoteConnection[]> {
  return ajaxGet({ url: '/api/v1/git_remote' });
}

export function connectGitRemote(data: {
  kind: GitRemoteKind;
  baseUrl: string;
  username?: string;
  token?: string;
}): Promise<GitRemoteConnection> {
  return ajaxPost({ url: '/api/v1/git_remote', data });
}

export function disconnectGitRemote({
  connectionId,
}: {
  connectionId: string;
}): Promise<{ removed: boolean }> {
  return ajaxDelete({ url: `/api/v1/git_remote/${connectionId}` });
}

export function getAvailableGitRemoteRepositories(
  connectionId: string,
): Promise<AvailableGitRemoteRepository[]> {
  return ajaxGet({ url: `/api/v1/git_remote/${connectionId}/available` });
}

export function addGitRemoteRepository({
  connectionId,
  fullName,
  cloneUrl,
}: {
  connectionId: string;
  fullName?: string;
  cloneUrl?: string;
}): Promise<GitRemoteRepository> {
  return ajaxPost({
    url: `/api/v1/git_remote/${connectionId}/repositories`,
    data: { fullName, cloneUrl },
  });
}

export function removeGitRemoteRepository({
  connectionId,
  repositoryId,
}: {
  connectionId: string;
  repositoryId: string;
}): Promise<GitRemoteRepository> {
  return ajaxDelete({
    url: `/api/v1/git_remote/${connectionId}/repositories/${encodeURIComponent(repositoryId)}`,
  });
}

export const GetGitRemotes = 'getGitRemotes';
export const GetAvailableGitRemoteRepositories =
  'getAvailableGitRemoteRepositories';

export function useGetGitRemotes(): UseQueryResult<
  GitRemoteConnection[],
  XHRErrorResponse
> {
  return useQuery({
    queryKey: [GetGitRemotes],
    queryFn: () => getGitRemotes(),
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useGetAvailableGitRemoteRepositories(
  connectionId: string,
  enabled: boolean,
): UseQueryResult<AvailableGitRemoteRepository[], XHRErrorResponse> {
  return useQuery({
    queryKey: [GetAvailableGitRemoteRepositories, connectionId],
    queryFn: () => getAvailableGitRemoteRepositories(connectionId),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export const useConnectGitRemoteMutation = mutationHook(connectGitRemote, {
  invalidates: [GetGitRemotes],
  fallback: 'The server refused this host, and it gave no reason.',
});

export const useDisconnectGitRemoteMutation = mutationHook(
  disconnectGitRemote,
  { invalidates: [GetGitRemotes] },
);

export const useAddGitRemoteRepositoryMutation = mutationHook(
  addGitRemoteRepository,
  {
    invalidates: [GetGitRemotes, GetAvailableGitRemoteRepositories],
    fallback: 'The server refused this repository, and it gave no reason.',
  },
);

export const useRemoveGitRemoteRepositoryMutation = mutationHook(
  removeGitRemoteRepository,
  { invalidates: [GetGitRemotes, GetAvailableGitRemoteRepositories] },
);
