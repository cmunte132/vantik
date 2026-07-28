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

import { resolveAdminWorkspaceId } from 'common/workspace-access';

/**
 * The repositories that a workspace has on the disk of this machine.
 *
 * The list is the `settings` of one integration account. That account is the
 * same kind of record that GitHub makes, so the repository picker of a module
 * reads a local repository and a remote repository in the same way.
 *
 * Adding and removing are for an admin, and reading is for any member. A path
 * names a directory on the machine that runs the server, not something inside
 * the workspace, so the person who adds one is choosing what this deployment
 * exposes to everybody in it. `LOCAL_REPO_ROOT` narrows which paths are
 * allowed at all; this decides who may ask.
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
    // The role on the access token is the role in the user's *first* workspace,
    // so an admin of one workspace passes a plain AdminGuard while browsing
    // another. The membership row of the workspace being written is the only
    // thing that answers the question actually being asked.
    const target = await resolveAdminWorkspaceId(
      this.prisma,
      userId,
      workspaceId,
    );

    return await addRepository(this.prisma, {
      workspaceId: target,
      userId,
      path,
    });
  }

  async remove(
    workspaceId: string,
    userId: string,
    repositoryId: string,
  ): Promise<LocalRepository> {
    const target = await resolveAdminWorkspaceId(
      this.prisma,
      userId,
      workspaceId,
    );

    return await removeRepository(this.prisma, {
      workspaceId: target,
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
