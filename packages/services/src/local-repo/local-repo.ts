import type { LocalRepository, RepositoryFolder } from '@vantikhq/types';

import axios from 'axios';

/**
 * The repositories that this workspace has on the disk of the server.
 *
 * These rows live in the `settings` of an integration account, so a write
 * arrives back over the socket as a sync action on that account. The caller
 * needs no refetch after a write.
 */
export async function getLocalRepositories(): Promise<LocalRepository[]> {
  const response = await axios.get('/api/v1/local_repo');

  return response.data;
}

export async function addLocalRepository({
  path,
}: {
  path: string;
}): Promise<LocalRepository> {
  const response = await axios.post('/api/v1/local_repo', { path });

  return response.data;
}

export async function removeLocalRepository({
  repositoryId,
}: {
  repositoryId: string;
}): Promise<LocalRepository> {
  const response = await axios.delete(`/api/v1/local_repo/${repositoryId}`);

  return response.data;
}

/**
 * The folders inside one repository that a module can claim.
 *
 * This answer describes the repository, and the repository belongs to the
 * workspace. Each module that connects the same repository reads the same
 * folders, and each one keeps its own choice among them.
 */
export async function getLocalRepositoryFolders({
  repositoryId,
}: {
  repositoryId: string;
}): Promise<RepositoryFolder[]> {
  const response = await axios.get(
    `/api/v1/local_repo/${repositoryId}/folders`,
  );

  return response.data;
}
