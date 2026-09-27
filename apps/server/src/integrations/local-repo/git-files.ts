import { execFile } from 'child_process';

import {
  cleanRepoPath,
  COMMIT_SHA,
  MAX_REPO_FILE_BYTES,
  REPO_READ_TIMEOUT_MS,
  type RepoFileRead,
  type RepoHead,
} from 'integrations/repo-files';

/**
 * Files of a repository on this machine, read for knowledge citations.
 *
 * Through git rather than the working tree, because a citation names a commit
 * and the checkout may be on any branch with any edits in it. `execFile` runs
 * git with an argument list and no shell, and the path and commit are checked
 * before they are joined into the one argument that names the object, so
 * neither can become an option or a second command.
 */

export interface GitResult {
  stdout: string;
  stderr: string;
  /** Null when git ran and exited 0. */
  error: (Error & { code?: string | number; killed?: boolean }) | null;
}

export type RunGit = (root: string, args: string[]) => Promise<GitResult>;

export const runGit: RunGit = (root, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      // A write waits on this, so a git stuck on a lock or a slow disk is
      // killed and the citation is unread, rather than holding the request.
      {
        maxBuffer: MAX_REPO_FILE_BYTES + 1,
        encoding: 'utf8',
        timeout: REPO_READ_TIMEOUT_MS,
      },
      (error, stdout, stderr) =>
        resolve({ stdout: String(stdout), stderr: String(stderr), error }),
    );
  });

/**
 * What git says when the checkout answered and there is no file there: the
 * path is not in that commit, the commit is not in the repository, or the path
 * is a folder (`bad file`). All are the citation's fault, not the checkout's.
 */
const NOT_THERE =
  /does not exist in|exists on disk, but not in|invalid object name|not a valid object name|bad revision|unknown revision|: bad file$/im;

export async function readLocalFile(
  root: string | null,
  path: string,
  ref: string,
  run: RunGit = runGit,
): Promise<RepoFileRead> {
  const clean = cleanRepoPath(path);

  if (!clean || !COMMIT_SHA.test(ref)) {
    return { unknown: true, reason: 'not a readable path or commit' };
  }

  if (!root) {
    return {
      unknown: true,
      reason: 'the workspace no longer lists this local repository',
    };
  }

  // `cat-file blob` rather than `show`, which prints a folder's listing as
  // if it were a file.
  const { stdout, stderr, error } = await run(root, [
    'cat-file',
    'blob',
    `${ref}:${clean}`,
  ]);

  if (!error) {
    return { content: stdout };
  }

  if (NOT_THERE.test(stderr)) {
    return { missing: true };
  }

  return { unknown: true, reason: gitReason(error, stderr) };
}

/**
 * The commit a local repository's default branch is at.
 *
 * The remote's default branch when the clone knows it, because that is what a
 * reviewer merges into; otherwise the checkout's own HEAD, which for a local
 * repository nobody pushes anywhere is the only branch there is.
 */
export async function localHead(
  root: string | null,
  run: RunGit = runGit,
): Promise<RepoHead> {
  if (!root) {
    return {
      unknown: true,
      reason: 'the workspace no longer lists this local repository',
    };
  }

  for (const name of ['refs/remotes/origin/HEAD', 'HEAD']) {
    const { stdout, error } = await run(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${name}^{commit}`,
    ]);
    const sha = stdout.trim();

    if (!error && COMMIT_SHA.test(sha)) {
      return { sha };
    }
  }

  return { unknown: true, reason: `git found no commit to check in ${root}` };
}

function gitReason(
  error: Error & { code?: string | number; killed?: boolean },
  stderr: string,
): string {
  if (error.code === 'ENOENT') {
    return 'git is not installed on this server';
  }

  if (error.killed) {
    return 'git took too long to answer';
  }

  if (/maxBuffer/i.test(error.message)) {
    return 'the file is too large to check';
  }

  return stderr.trim().split('\n')[0] || error.message;
}
