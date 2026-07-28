import { Injectable } from '@nestjs/common';
import {
  listRepositoryFolders,
  RepositoryFolder,
} from 'integrations/local-repo/folders';
import {
  addRepository,
  listRepositories,
  LocalRepository,
  removeRepository,
  resolveRepositoryPath,
} from 'integrations/local-repo/repositories';
import { PrismaService } from 'nestjs-prisma';

/**
 * The repositories that a workspace has on the disk of this machine.
 *
 * The list is the `settings` of one integration account. That account is the
 * same kind of record that GitHub makes, so the repository picker of a module
 * reads a local repository and a remote repository in the same way.
 */
@Injectable()
export class LocalRepoService {
  constructor(private prisma: PrismaService) {}

  async list(workspaceId: string): Promise<LocalRepository[]> {
    return await listRepositories(this.prisma, workspaceId);
  }

  async add(
    workspaceId: string,
    userId: string,
    path: string,
  ): Promise<LocalRepository> {
    return await addRepository(this.prisma, { workspaceId, userId, path });
  }

  async remove(
    workspaceId: string,
    userId: string,
    repositoryId: string,
  ): Promise<LocalRepository> {
    return await removeRepository(this.prisma, {
      workspaceId,
      userId,
      repositoryId,
    });
  }

  /**
   * This method returns the folders that a module can claim inside one
   * repository.
   */
  async folders(
    workspaceId: string,
    repositoryId: string,
  ): Promise<RepositoryFolder[]> {
    return await listRepositoryFolders(this.prisma, workspaceId, repositoryId);
  }

  /**
   * This method returns the path of one repository, or null.
   *
   * A `ModuleRepo` row holds the identifier and not the path. An agent that
   * must open the checkout of a module reads the path here.
   */
  async pathOf(
    workspaceId: string,
    repositoryId: string,
  ): Promise<string | null> {
    return await resolveRepositoryPath(this.prisma, workspaceId, repositoryId);
  }
}
