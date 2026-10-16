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
 * How git reports a lost race: the lease is stale, or the ref moved while the
 * push ran. A later pass can try again.
 */
const RACE = /stale info|cannot lock ref/i;

/**
 * How a host refuses a push by its own rule: a protected ref, a hook, or a
 * token without the right to write. This is not a race. The same push fails
 * on each pass until somebody changes the host.
 */
const HOST_REFUSED = /remote rejected|denied|not allowed|forbidden|\b403\b/i;

/**
 * The host of the source refused a push of a `refs/vantik/*` ref. The message
 * says what the host answered, so the log shows the cause once for each pass.
 */
export class HostRefusedPushError extends Error {
  constructor(
    readonly ref: string,
    readonly reason: string,
  ) {
    super(
      `The host refused the push of ${ref}: ${reason}. The issue mirror needs a token that can write refs/vantik/* in this repository, and a host rule that allows those refs`,
    );
    this.name = 'HostRefusedPushError';
  }
}

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
    if (error instanceof GitCommandError) {
      if (RACE.test(error.stderr)) {
        return false;
      }

      if (HOST_REFUSED.test(error.stderr)) {
        throw new HostRefusedPushError(
          refspec.slice(refspec.lastIndexOf(':') + 1),
          refusalLine(error.stderr),
        );
      }

      // Plain `[rejected]`: the ref is not where the lease expected it.
      if (/\[rejected\]|failed to push some refs/i.test(error.stderr)) {
        return false;
      }
    }

    throw error;
  }
}

/** The line of the git output that says why, without credentials or URLs. */
function refusalLine(stderr: string): string {
  const line =
    stderr
      .split('\n')
      .find((candidate) =>
        /rejected|denied|not allowed|forbidden|403/i.test(candidate),
      ) ??
    stderr.trim().split('\n')[0] ??
    'no reason given';

  return line
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/^\s*!\s*/, '')
    .trim()
    .slice(0, 300);
}
