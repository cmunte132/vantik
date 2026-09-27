import { execFile } from 'child_process';

import {
  cleanRepoPath,
  COMMIT_SHA,
  MAX_REPO_FILE_BYTES,
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
  error: (Error & { code?: string | number }) | null;
}

export type RunGit = (root: string, args: string[]) => Promise<GitResult>;

export const runGit: RunGit = (root, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { maxBuffer: MAX_REPO_FILE_BYTES + 1, encoding: 'utf8' },
      (error, stdout, stderr) =>
        resolve({ stdout: String(stdout), stderr: String(stderr), error }),
    );
  });

/**
 * What git says when the checkout answered and the object is not in it: the
 * path is not in that commit, or the commit is not in the repository. Both are
 * the citation's fault, not the checkout's.
 */
const NOT_THERE =
  /does not exist in|exists on disk, but not in|invalid object name|not a valid object name|bad revision|unknown revision/i;

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

  const { stdout, stderr, error } = await run(root, [
    'show',
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
  error: Error & { code?: string | number },
  stderr: string,
): string {
  if (error.code === 'ENOENT') {
    return 'git is not installed on this server';
  }

  if (/maxBuffer/i.test(error.message)) {
    return 'the file is too large to check';
  }

  return stderr.trim().split('\n')[0] || error.message;
}
