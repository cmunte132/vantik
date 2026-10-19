import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { GIT_REMOTE_SLUG } from 'modules/git/sources/git-remote.source';

import { remoteSourceKey } from './mirror-source';
import { type MirroredRepository, type MirrorTargets } from './mirror-targets';

/**
 * The repositories of the git remote integration that an admin opted in. The
 * setting is `gitIssues.teamIds` in the entry of the repository, in the
 * `repositories` list of the account settings.
 *
 * The push and the fetch use the connection of the repository: its address
 * and its token. `GitRemoteSource` supplies both, so this list holds neither.
 */
@Injectable()
export class GitRemoteRepositoryTargets implements MirrorTargets {
  constructor(private prisma: PrismaService) {}

  async list(): Promise<MirroredRepository[]> {
    const accounts = await this.prisma.integrationAccount.findMany({
      where: {
        deleted: null,
        integrationDefinition: { slug: GIT_REMOTE_SLUG },
      },
      select: { id: true, workspaceId: true, settings: true },
      // The oldest account comes first, so it keeps a source that two claim.
      orderBy: { createdAt: 'asc' },
    });

    return accounts.flatMap((account) =>
      entriesOf(account.settings)
        .filter((entry) => entry.teamIds.length > 0)
        .map((entry) => ({
          workspaceId: account.workspaceId,
          integrationAccountId: account.id,
          externalRepoId: entry.id,
          label: entry.fullName,
          // An entry without an address shares its source with no other.
          sourceKey: entry.cloneUrl
            ? remoteSourceKey(entry.cloneUrl)
            : `remote:unaddressed:${account.id}:${entry.id}`,
          teamIds: entry.teamIds,
        })),
    );
  }
}

interface Entry {
  id: string;
  fullName: string;
  cloneUrl: string | null;
  teamIds: string[];
}

/** The settings column can hold a JSON string, and nothing in it is trusted. */
function entriesOf(settings: unknown): Entry[] {
  let value = settings;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }

  const repositories = (value as { repositories?: unknown } | null)
    ?.repositories;

  if (!Array.isArray(repositories)) {
    return [];
  }

  return repositories.flatMap((raw): Entry[] => {
    const entry = raw as {
      id?: unknown;
      fullName?: unknown;
      cloneUrl?: unknown;
      gitIssues?: { teamIds?: unknown };
    } | null;
    const teamIds = Array.isArray(entry?.gitIssues?.teamIds)
      ? entry.gitIssues.teamIds.filter(
          (id): id is string => typeof id === 'string',
        )
      : [];

    return typeof entry?.id === 'string'
      ? [
          {
            id: entry.id,
            fullName:
              typeof entry.fullName === 'string' ? entry.fullName : entry.id,
            cloneUrl:
              typeof entry.cloneUrl === 'string' ? entry.cloneUrl : null,
            teamIds,
          },
        ]
      : [];
  });
}
