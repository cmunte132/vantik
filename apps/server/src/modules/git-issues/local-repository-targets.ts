import { Injectable } from '@nestjs/common';
import {
  LOCAL_REPO_SLUG,
  readRepositories,
} from 'integrations/local-repo/repositories';
import { PrismaService } from 'nestjs-prisma';

import { localSourceKey } from './mirror-source';
import { type MirroredRepository, type MirrorTargets } from './mirror-targets';

/**
 * The repositories of the local repository integration that an admin opted
 * in. The setting is `gitIssues.teamIds` in the entry of the repository.
 */
@Injectable()
export class LocalRepositoryTargets implements MirrorTargets {
  constructor(private prisma: PrismaService) {}

  async list(): Promise<MirroredRepository[]> {
    const accounts = await this.prisma.integrationAccount.findMany({
      where: {
        deleted: null,
        integrationDefinition: { slug: LOCAL_REPO_SLUG },
      },
      select: { id: true, workspaceId: true, settings: true },
      // The oldest account comes first, so it keeps a source that two claim.
      orderBy: { createdAt: 'asc' },
    });

    const listed: MirroredRepository[] = [];

    for (const account of accounts) {
      for (const repository of readRepositories(account.settings)) {
        if (!repository.gitIssues?.teamIds?.length) {
          continue;
        }

        listed.push({
          workspaceId: account.workspaceId,
          integrationAccountId: account.id,
          externalRepoId: repository.id,
          label: repository.path,
          sourceKey: await localSourceKey(repository.path),
          teamIds: repository.gitIssues.teamIds,
        });
      }
    }

    return listed;
  }
}
