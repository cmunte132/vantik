import { Injectable } from '@nestjs/common';
import {
  REPO_SOURCE_TIMEOUT_MS,
  type RepoFileRead,
  type RepoHead,
} from 'integrations/repo-files';

import {
  GitSourcesService,
  type ResolvedRepo,
} from 'modules/git/git-sources.service';
import { RepoMirrorService } from 'modules/git/repo-mirror.service';

/** A module's repository, as much of the `ModuleRepo` row as reading needs. */
export interface CitedRepo {
  id: string;
  fullName: string;
  externalRepoId: string;
  integrationAccountId: string | null;
  workspaceId: string;
}

/**
 * Reads a path at a ref for a module's repository, whatever the repository's
 * source.
 *
 * One interface for every source, so what a citation check does never depends
 * on where the code lives. A repository whose source cannot be asked answers
 * `unknown`, never `missing`: the check is then retried, and the claim is not
 * held against the code for the server's failure to read it.
 */
export interface RepoFileSource {
  read(repo: CitedRepo, path: string, ref: string): Promise<RepoFileRead>;
  /** The commit at the head of the repository's default branch. */
  head(repo: CitedRepo): Promise<RepoHead>;
}

/**
 * Every read goes to the server's mirror of the repository, for every source.
 * The source is asked only to fetch, so a citation of a GitHub repository and
 * of a directory on this machine are checked by the same git commands.
 */
@Injectable()
export default class RepoFileSourceService implements RepoFileSource {
  constructor(
    private gitSources: GitSourcesService,
    private mirrors: RepoMirrorService,
  ) {}

  read(repo: CitedRepo, path: string, ref: string): Promise<RepoFileRead> {
    return bounded(
      this.withRepo(repo, (resolved) =>
        this.mirrors.readFile(resolved, path, ref),
      ),
    );
  }

  head(repo: CitedRepo): Promise<RepoHead> {
    return bounded(
      this.withRepo(repo, (resolved) => this.mirrors.head(resolved)),
    );
  }

  /**
   * Resolves the repository through its integration account. Only an account
   * in the repository's own workspace counts, so a row naming another
   * workspace's account reads nothing.
   */
  private async withRepo<T extends RepoFileRead | RepoHead>(
    repo: CitedRepo,
    read: (resolved: ResolvedRepo) => Promise<T>,
  ): Promise<T | { unknown: true; reason: string }> {
    try {
      const resolved = await this.gitSources.resolve(repo);

      if ('unresolved' in resolved) {
        return {
          unknown: true,
          reason: `${repo.fullName} cannot be read: ${resolved.unresolved}`,
        };
      }

      return await read(resolved);
    } catch (error) {
      return {
        unknown: true,
        reason: `the repository could not be read: ${(error as Error)?.message ?? error}`,
      };
    }
  }
}

/**
 * A read that has not answered in time is unread. Each git command has its
 * own timeout, but a read can make several (a token, a fetch, the file), and a
 * write waits on every citation. A first fetch of a large repository runs on
 * past this and fills the mirror; the citation is read on the retry.
 */
async function bounded<T>(
  work: Promise<T>,
): Promise<T | { unknown: true; reason: string }> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ unknown: true; reason: string }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          unknown: true,
          reason: `the repository did not answer within ${REPO_SOURCE_TIMEOUT_MS / 1000} seconds`,
        }),
      REPO_SOURCE_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
