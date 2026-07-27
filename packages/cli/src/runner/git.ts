import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { RunnerError } from './failures';

const run = promisify(execFile);

/**
 * Git, as the runner needs it.
 *
 * `execFile` rather than a shell throughout: every argument here can contain a
 * branch name derived from an issue title, and an issue title is attacker-
 * controlled content. Passing that through a shell is a command-injection hole
 * dressed up as string interpolation.
 */
export async function git(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      // Never let git open an editor or prompt for credentials: a runner has
      // no terminal, and a prompt would hang until the lease expired.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
      },
    });
    return stdout;
  } catch (error) {
    if (options.allowFailure) {
      return '';
    }
    const message =
      (error as { stderr?: string })?.stderr ||
      (error as Error)?.message ||
      'git failed';
    throw new RunnerError(
      'ENVIRONMENT_SETUP_FAILED',
      `git ${args[0]} failed: ${message.trim()}`,
      error,
    );
  }
}

/** The commit a checkout is currently on. */
export async function headCommit(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

/**
 * A branch name from an issue key and title.
 *
 * Slugged hard, because git refs reject a lot of what a title can contain and
 * a title is user input. Anything outside the safe set becomes a hyphen, runs
 * collapse, and the result is truncated — long branch names break on some
 * hosts and read badly everywhere.
 */
export function branchName(
  prefix: string,
  issueKey: string,
  title: string,
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  const key = issueKey.toLowerCase();
  const clean = prefix.replace(/\/+$/, '');

  return slug ? `${clean}/${key}-${slug}` : `${clean}/${key}`;
}

/**
 * The patch a run produced, as `git diff` against the recorded base.
 *
 * The single highest-leverage mundane detail in the whole runner. Computing
 * the patch this way scored 73.4% where asking the same model to emit a
 * unified diff scored 19.1% — a gap that is line numbers, hunk headers and
 * trailing newlines, not intelligence. A model-emitted diff is never parsed
 * here, and there is no code path that could.
 *
 * Untracked files are added to the index first (without committing) so new
 * files appear in the diff at all; `git diff` alone would silently omit
 * exactly the files a feature-adding run creates.
 */
export async function patchAgainst(
  cwd: string,
  baseCommit: string,
): Promise<string> {
  await git(cwd, ['add', '-A']);
  return git(cwd, ['diff', '--cached', '--binary', baseCommit]);
}

/** Whether anything actually changed relative to the base. */
export async function hasChanges(
  cwd: string,
  baseCommit: string,
): Promise<boolean> {
  await git(cwd, ['add', '-A']);
  const names = await git(cwd, ['diff', '--cached', '--name-only', baseCommit]);
  return names.trim().length > 0;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export async function diffStat(
  cwd: string,
  baseCommit: string,
): Promise<DiffStat> {
  const raw = await git(cwd, ['diff', '--cached', '--numstat', baseCommit]);

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [added = '', removed = ''] = line.split('\t');
    filesChanged += 1;
    // Binary files report "-" for both counts.
    insertions += Number.parseInt(added, 10) || 0;
    deletions += Number.parseInt(removed, 10) || 0;
  }

  return { filesChanged, insertions, deletions };
}

/**
 * Removes harness scratch from the working tree before anything is staged.
 *
 * A harness that writes session state, logs or a plan file into the working
 * directory would otherwise have them show up as part of the change — and a
 * reviewer who sees `.pi/` in a pull request rightly stops trusting the rest
 * of the diff.
 *
 * Deleted from disk rather than merely unstaged. Unstaging is useless here:
 * every later step runs `git add -A`, which puts the files straight back. The
 * scratch checkout is discarded at the end of the run either way, so there is
 * nothing to preserve.
 */
export async function scrubArtifacts(
  cwd: string,
  paths: string[],
): Promise<void> {
  for (const path of paths) {
    // Refuse anything that could escape the checkout. These names are
    // constants today, but a config-supplied artifact path is an obvious next
    // step and `rm -rf` deserves the guard now rather than later.
    if (path.startsWith('/') || path.split('/').includes('..')) {
      continue;
    }

    await rm(join(cwd, path), { recursive: true, force: true }).catch(
      () => undefined,
    );

    await git(cwd, ['rm', '-rf', '--cached', '--ignore-unmatch', path], {
      allowFailure: true,
    });
  }
}

export async function commitAll(
  cwd: string,
  message: string,
  author: { name: string; email: string },
): Promise<string> {
  await git(cwd, ['add', '-A']);
  await git(cwd, [
    '-c',
    `user.name=${author.name}`,
    '-c',
    `user.email=${author.email}`,
    'commit',
    '--no-verify',
    '-m',
    message,
  ]);
  return headCommit(cwd);
}

/**
 * Pushes a branch, distinguishing "rejected" from "could not reach the host".
 *
 * Those are different problems with different fixes — branch protection versus
 * a network or credential failure — and collapsing them into one error is how
 * a user ends up rotating a token that was never the issue.
 */
export async function pushBranch(
  cwd: string,
  remote: string,
  branch: string,
): Promise<void> {
  try {
    await git(cwd, ['push', '--set-upstream', remote, branch]);
  } catch (error) {
    const message = String(
      (error as { cause?: { stderr?: string } })?.cause?.stderr ??
        (error as Error).message,
    );

    const unreachable =
      /could not resolve host|connection refused|network is unreachable|timed out/i.test(
        message,
      );

    throw new RunnerError(
      unreachable ? 'EGRESS_DENIED' : 'PUSH_REJECTED',
      unreachable
        ? `Could not reach ${remote}: ${message.trim()}`
        : `The remote refused the push: ${message.trim()}`,
      error,
    );
  }
}

/** Whether a path is inside a git work tree at all. */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return inside.trim() === 'true';
  } catch {
    return false;
  }
}

export async function hasRemote(cwd: string, remote: string): Promise<boolean> {
  const remotes = await git(cwd, ['remote'], { allowFailure: true });
  return remotes.split('\n').some((line) => line.trim() === remote);
}
