import {
  git,
  GitCommandError,
  type GitRemote,
  localTransportArgs,
} from 'modules/git/git-command';

/**
 * The part of a pass that talks to the source of a repository.
 *
 * The mirror is the server's bare copy. The source is the repository that
 * people and agents use. A pass reads the issue refs of the source into the
 * mirror, works on the mirror, and writes back only two kinds of change: one
 * push of the snapshot ref, and one push that deletes an inbox ref. Both
 * pushes are compare-and-set against the commit that the pass read, so a pass
 * never overwrites a change that it did not see.
 */
export interface IssueRemote {
  /**
   * Runs `work` while nothing else changes the mirror. A normal fetch of the
   * branches uses the same lock.
   */
  exclusive<T>(work: () => Promise<T>): Promise<T>;

  /**
   * Copies `refs/vantik/issues` and every `refs/vantik/inbox/*` of the source
   * into the mirror, and removes from the mirror the refs that the source no
   * longer has.
   */
  fetchRefs(): Promise<void>;

  /**
   * Pushes `sha` to `refs/vantik/issues` of the source. This method returns
   * false if the ref is not at `expected` any more, and it does not push in
   * that case. `expected` null means that the ref must not exist.
   */
  pushSnapshot(sha: string, expected: string | null): Promise<boolean>;

  /**
   * Deletes one inbox ref of the source, only if it is still at `expected`.
   * This method returns false if the ref moved.
   */
  deleteInbox(ref: string, expected: string): Promise<boolean>;
}

export const SNAPSHOT_REF = 'refs/vantik/issues';
export const INBOX_PREFIX = 'refs/vantik/inbox/';

/**
 * How git rejects a compare-and-set push: the lease is stale, the ref is
 * missing where the lease expected one, or the remote refused the update.
 */
const LEASE_FAILED =
  /stale info|\[rejected\]|\[remote rejected\]|failed to push some refs|cannot lock ref/i;

/**
 * The source, reached through the mirror at `mirrorPath`. A source can use one
 * address and one credential to read, and another to write.
 */
export function gitIssueRemote(
  mirrorPath: string,
  remotes: { fetch: GitRemote; push: GitRemote },
  exclusive: IssueRemote['exclusive'],
): IssueRemote {
  return {
    exclusive,

    async fetchRefs() {
      // `ls-remote` first, because a refspec without a wildcard fails when
      // the ref is not there, and a source with no issue mirror yet is the
      // normal case on the first pass.
      const listing = await git(
        [
          'ls-remote',
          ...localTransportArgs(remotes.fetch.url, 'upload-pack'),
          remotes.fetch.url,
          SNAPSHOT_REF,
          `${INBOX_PREFIX}*`,
        ],
        { cwd: mirrorPath, remote: remotes.fetch },
      );
      const hasSnapshot = listing
        .split('\n')
        .some((line) => line.split('\t')[1] === SNAPSHOT_REF);

      if (!hasSnapshot) {
        await git(['update-ref', '-d', SNAPSHOT_REF], { cwd: mirrorPath });
      }

      // `--prune` removes only the refs that match the destination of a
      // refspec on this command line, so it cannot touch the branches.
      await git(
        [
          'fetch',
          '--quiet',
          '--prune',
          '--no-tags',
          ...localTransportArgs(remotes.fetch.url, 'upload-pack'),
          remotes.fetch.url,
          `+${INBOX_PREFIX}*:${INBOX_PREFIX}*`,
          ...(hasSnapshot ? [`+${SNAPSHOT_REF}:${SNAPSHOT_REF}`] : []),
        ],
        { cwd: mirrorPath, remote: remotes.fetch },
      );
    },

    async pushSnapshot(sha, expected) {
      return await push(
        `--force-with-lease=${SNAPSHOT_REF}:${expected ?? ''}`,
        `${sha}:${SNAPSHOT_REF}`,
        mirrorPath,
        remotes.push,
      );
    },

    async deleteInbox(ref, expected) {
      return await push(
        `--force-with-lease=${ref}:${expected}`,
        `:${ref}`,
        mirrorPath,
        remotes.push,
      );
    },
  };
}

async function push(
  lease: string,
  refspec: string,
  mirrorPath: string,
  remote: GitRemote,
): Promise<boolean> {
  try {
    await git(
      [
        'push',
        '--quiet',
        '--no-verify',
        ...localTransportArgs(remote.url, 'receive-pack'),
        lease,
        remote.url,
        refspec,
      ],
      { cwd: mirrorPath, remote },
    );

    return true;
  } catch (error) {
    if (error instanceof GitCommandError && LEASE_FAILED.test(error.stderr)) {
      return false;
    }

    throw error;
  }
}
