/**
 * What reading a repository file can answer, for any source of repositories.
 *
 * Three answers, not two, because "the file is not there" and "the repository
 * could not be asked" mean opposite things for a citation. The first is
 * evidence: the cited code is gone. The second is nothing: a rate limit, a
 * revoked token or a checkout on a disk that is not mounted says nothing about
 * the code, so it must never count against a claim. It is retried instead.
 */
export type RepoFileRead =
  | { content: string }
  | { missing: true }
  | {
      unknown: true;
      reason: string;
      /**
       * Set when the reason is this file (too large, or not a path a source
       * may be asked for) rather than the source, so a caller reading many
       * files knows the repository itself may still answer.
       */
      thisFileOnly?: true;
    };

export type RepoHead = { sha: string } | { unknown: true; reason: string };

/** A commit id, full or abbreviated. The only refs a citation may name. */
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/** The largest file read for a citation, in bytes. */
export const MAX_REPO_FILE_BYTES = 1_000_000;

/**
 * How long one read may take. A write waits on its citations, so a source
 * that hangs gives an unread citation, retried later, not a stuck request.
 */
export const REPO_READ_TIMEOUT_MS = 10_000;

/**
 * How long one read may take in all: a token, the file, and the check that a
 * 404 came from the repository. It bounds the calls no single timeout covers.
 */
export const REPO_SOURCE_TIMEOUT_MS = 15_000;

/**
 * A repository-relative path, cleaned, or null if it could reach outside the
 * repository or name nothing.
 *
 * Every source joins this to something (a URL, a git object name), so the
 * check is made once, here, before any of them see it.
 */
export function cleanRepoPath(path: string | undefined): string | null {
  const trimmed = (path ?? '').trim().replace(/^(\.\/)+/, '');

  if (
    !trimmed ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    trimmed
      .split('/')
      .some((segment) => segment === '..' || segment === '.' || segment === '')
  ) {
    return null;
  }

  return trimmed;
}
