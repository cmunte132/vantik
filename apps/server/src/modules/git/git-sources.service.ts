import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { type GitSource, type SourceRepo } from './git-source';
import { GithubSource } from './sources/github.source';
import { LocalDirectorySource } from './sources/local-directory.source';

/** How a `ModuleRepo` row, or anything shaped like one, names a repository. */
export interface RepoRef {
  workspaceId: string;
  integrationAccountId: string | null;
  externalRepoId: string;
}

export interface ResolvedRepo {
  source: GitSource;
  repo: SourceRepo;
}

/**
 * Turns a repository reference into a source and a checked repository.
 *
 * This is the one place that decides whether a reference is real. The
 * integration account must be in the same workspace, must not be deleted, and
 * must list the repository in its settings. A reference that fails any of
 * these resolves to nothing, whoever wrote it, so a row that names another
 * workspace's account, or a repository nobody connected, reads and pushes
 * nothing.
 */
@Injectable()
export class GitSourcesService {
  private readonly sources: Map<string, GitSource>;

  constructor(
    private prisma: PrismaService,
    github: GithubSource,
  ) {
    this.sources = new Map(
      [github, new LocalDirectorySource()].map((source) => [
        source.slug,
        source,
      ]),
    );
  }

  /** The source and the repository, or null with the reason. */
  async resolve(ref: RepoRef): Promise<ResolvedRepo | { unresolved: string }> {
    if (!ref.integrationAccountId) {
      return {
        unresolved: 'the repository is not linked to a connected source',
      };
    }

    const account = await this.prisma.integrationAccount.findFirst({
      where: {
        id: ref.integrationAccountId,
        workspaceId: ref.workspaceId,
        deleted: null,
      },
      select: {
        id: true,
        accountId: true,
        settings: true,
        integrationDefinition: { select: { slug: true } },
      },
    });

    if (!account) {
      return {
        unresolved: 'the source of the repository is no longer connected',
      };
    }

    const slug = account.integrationDefinition?.slug ?? '';
    const source = this.sources.get(slug);

    if (!source) {
      return {
        unresolved: `${slug || 'this integration'} is not a git source`,
      };
    }

    const listing = repositoriesOf(account.settings).find(
      (entry) => String(entry.id) === ref.externalRepoId,
    );

    if (!listing) {
      return {
        unresolved: 'the connected source no longer offers this repository',
      };
    }

    return {
      source,
      repo: {
        workspaceId: ref.workspaceId,
        integrationAccountId: account.id,
        accountId: account.accountId ?? '',
        externalRepoId: ref.externalRepoId,
        fullName: String(listing.fullName ?? ref.externalRepoId),
        listing,
      },
    };
  }

  /** As `resolve`, but throws a request error with the reason. */
  async require(ref: RepoRef): Promise<ResolvedRepo> {
    const resolved = await this.resolve(ref);

    if ('unresolved' in resolved) {
      throw new BadRequestException(
        `This repository cannot be used: ${resolved.unresolved}.`,
      );
    }

    return resolved;
  }

  /** Whether an integration definition is one of the git sources. */
  isGitSource(slug: string): boolean {
    return this.sources.has(slug);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function repositoriesOf(settings: any): Array<Record<string, unknown>> {
  const parsed = typeof settings === 'string' ? safeParse(settings) : settings;
  const repositories = parsed?.repositories;

  return Array.isArray(repositories)
    ? repositories.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object',
      )
    : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
