import {
  inspectPath,
  LOCAL_REPO_SLUG,
} from 'integrations/local-repo/repositories';

import { anonymousRemote, git, type GitRemote } from '../git-command';
import { type GitSource, type SourceRepo } from '../git-source';

/**
 * A git repository in a directory on the machine that runs the server.
 *
 * The directory is a remote like any other: the server fetches from it into
 * its mirror, and pushes the agent's branch back into it. It is never read as
 * a working tree, so the files a person has not committed, and the branch
 * they have checked out, change nothing that the server sees.
 *
 * The path is checked again on every use, not only when it was added. The
 * fence (`LOCAL_REPO_ROOT`) can move between the two, and a directory can be
 * deleted or replaced by a link.
 */
export class LocalDirectorySource implements GitSource {
  readonly slug = LOCAL_REPO_SLUG;

  /** Nothing tells the server when a person commits. */
  readonly notifies = false;

  async fetchRemote(repo: SourceRepo): Promise<GitRemote> {
    return anonymousRemote(await this.path(repo));
  }

  async pushRemote(repo: SourceRepo): Promise<GitRemote> {
    return anonymousRemote(await this.path(repo));
  }

  /**
   * The branch the directory's own upstream calls its default, else `main` or
   * `master`, else null for the HEAD it advertises.
   *
   * Not the checked-out branch first. A person works on a feature branch in
   * this directory, and an agent that started from it would build on their
   * unfinished work.
   */
  async defaultBranch(repo: SourceRepo): Promise<string | null> {
    const path = await this.path(repo);
    const upstream = await quiet(
      git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
        cwd: path,
      }),
    );

    if (upstream?.trim().startsWith('origin/')) {
      const name = upstream.trim().slice('origin/'.length);

      if (await hasBranch(path, name)) {
        return name;
      }
    }

    for (const name of ['main', 'master']) {
      if (await hasBranch(path, name)) {
        return name;
      }
    }

    return null;
  }

  location(repo: SourceRepo): string {
    return typeof repo.listing.path === 'string'
      ? repo.listing.path
      : repo.fullName;
  }

  private async path(repo: SourceRepo): Promise<string> {
    if (typeof repo.listing.path !== 'string') {
      throw new Error(
        `${repo.fullName} has no path in its local repository entry.`,
      );
    }

    return await inspectPath(repo.listing.path);
  }
}

async function hasBranch(path: string, name: string): Promise<boolean> {
  const sha = await quiet(
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`], {
      cwd: path,
    }),
  );

  return Boolean(sha?.trim());
}

async function quiet(work: Promise<string>): Promise<string | null> {
  try {
    return await work;
  } catch {
    return null;
  }
}
