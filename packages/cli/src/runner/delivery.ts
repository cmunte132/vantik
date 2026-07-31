import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { RunnerError } from './failures';
import { commitAll, git, hasRemote, pushBranch } from './git';

const exec = promisify(execFile);

export type Delivery = 'pull_request' | 'worktree';

export interface DeliveryResult {
  delivery: Delivery;
  branch: string;
  headCommit: string;
  /** Only for `pull_request`. */
  prUrl?: string;
  /** Only for `worktree`. Where the user should look. */
  worktreePath?: string;
}

export interface DeliverOptions {
  /** The scratch checkout the harness worked in. */
  workdir: string;
  /** The user's own repository. Where a worktree is attached. */
  repoPath?: string;
  branch: string;
  issueKey: string;
  issueTitle: string;
  summary: string;
  issueUrl?: string | null;
  delivery: Delivery;
  worktreeRoot?: string;
  baseBranch?: string;
  /** Leave the work on disk and do nothing outward-facing. */
  dryRun?: boolean;
  onEvent?: (message: string) => void;
}

const AUTHOR = {
  name: 'Vantik Agent',
  email: 'agent@vantik.local',
};

/**
 * Turns a finished run into something a human can review.
 *
 * Two shapes, and neither is a degraded version of the other. With a remote
 * configured the work becomes a branch and a pull request. Without one — a
 * local checkout, a self-hosted install with no git host, an air-gapped repo —
 * it becomes a branch in a worktree beside the repository, which the user
 * reviews with the diff tooling they already have.
 *
 * The second case is the one that makes this feature usable at all for most
 * self-hosters, so it gets the same care: a real commit, a real branch, and a
 * path that is ready to `cd` into.
 */
export async function deliver(
  options: DeliverOptions,
): Promise<DeliveryResult> {
  const message = commitMessage(options);
  const head = await commitAll(options.workdir, message, AUTHOR);

  options.onEvent?.(`Committed ${head.slice(0, 8)} on ${options.branch}`);

  if (options.dryRun) {
    // Deliberately not a delivery. Dry-run is a debugging aid: the diff is on
    // disk in the scratch checkout and nothing outward-facing happened.
    options.onEvent?.(`Dry run — work left at ${options.workdir}`);
    return {
      delivery: 'worktree',
      branch: options.branch,
      headCommit: head,
      worktreePath: options.workdir,
    };
  }

  return options.delivery === 'pull_request'
    ? deliverPullRequest(options, head)
    : deliverWorktree(options, head);
}

/**
 * Pushes the branch and opens a pull request.
 *
 * The PR step is allowed to fail without losing the work: the branch is
 * already up, so a failure here is annoying rather than destructive, and it
 * gets its own category so the user is told to open it by hand rather than to
 * re-run everything.
 */
async function deliverPullRequest(
  options: DeliverOptions,
  head: string,
): Promise<DeliveryResult> {
  if (!(await hasRemote(options.workdir, 'origin'))) {
    throw new RunnerError(
      'PUSH_REJECTED',
      'This checkout has no "origin" remote, so there is nowhere to push. Configure a remote, or use worktree delivery.',
    );
  }

  options.onEvent?.(`Pushing ${options.branch}`);
  await pushBranch(options.workdir, 'origin', options.branch);

  const prUrl = await openPullRequest(options);

  return {
    delivery: 'pull_request',
    branch: options.branch,
    headCommit: head,
    prUrl,
  };
}

/**
 * Opens a pull request through the `gh` CLI when it is available.
 *
 * Deliberately shelling out rather than holding a git-host token: the runner's
 * whole premise is that credentials stay on the user's machine and never reach
 * the server, and `gh` is where a developer's GitHub credentials already live.
 * Absent `gh`, the branch is still pushed and the run reports the branch — the
 * work is never lost for want of a pull request.
 */
async function openPullRequest(
  options: DeliverOptions,
): Promise<string | undefined> {
  const body = [
    options.summary,
    '',
    options.issueUrl ? `Issue: ${options.issueUrl}` : `Issue: ${options.issueKey}`,
    '',
    '---',
    '',
    '_Opened by a Vantik agent. Review the diff, not the transcript._',
  ].join('\n');

  try {
    const { stdout } = await exec(
      'gh',
      [
        'pr',
        'create',
        '--title',
        `${options.issueKey}: ${options.issueTitle}`,
        '--body',
        body,
        ...(options.baseBranch ? ['--base', options.baseBranch] : []),
        '--head',
        options.branch,
      ],
      { cwd: options.workdir, timeout: 60_000 },
    );

    const url = stdout.trim().split('\n').pop()?.trim();
    options.onEvent?.(`Opened ${url}`);
    return url;
  } catch (error) {
    const message = String(
      (error as { stderr?: string })?.stderr ?? (error as Error).message,
    );

    // No gh installed is not a failure — the branch is up and the run
    // reports it. Anything else is a real PR-creation failure.
    if (/ENOENT|command not found/i.test(message)) {
      options.onEvent?.(
        'gh is not installed, so no pull request was opened. The branch is pushed.',
      );
      return undefined;
    }

    throw new RunnerError(
      'PR_CREATION_FAILED',
      `The branch is pushed but opening the pull request failed: ${message.trim()}`,
      error,
    );
  }
}

/**
 * Leaves the branch in a git worktree beside the user's repository.
 *
 * The branch is fetched from the scratch clone into the real repo, then
 * checked out as a worktree. So the user ends up with the work in their own
 * repository's object store — reviewable with their own tooling, and not
 * dependent on a temporary directory that gets cleaned up.
 *
 * Placed beside the repo rather than inside it. A worktree under the working
 * copy shows up in the agent's own file listings and in `git status`, which
 * pollutes the very context the next run depends on.
 */
async function deliverWorktree(
  options: DeliverOptions,
  head: string,
): Promise<DeliveryResult> {
  if (!options.repoPath) {
    // Nothing to attach to, so the scratch checkout is the deliverable. Say
    // so honestly rather than pretending a worktree was created.
    options.onEvent?.(`Work left at ${options.workdir}`);
    return {
      delivery: 'worktree',
      branch: options.branch,
      headCommit: head,
      worktreePath: options.workdir,
    };
  }

  const repo = resolve(options.repoPath);
  const root = options.worktreeRoot
    ? resolve(options.worktreeRoot)
    : join(dirname(repo), `${basename(repo)}-worktrees`);

  await mkdir(root, { recursive: true });

  const target = join(root, options.issueKey.toLowerCase());

  // Bring the commit into the user's own repository, so the worktree does not
  // depend on the scratch clone surviving.
  await git(repo, ['fetch', '--quiet', options.workdir, `${options.branch}:${options.branch}`]);

  // A stale worktree from a previous attempt would make `worktree add` fail.
  await git(repo, ['worktree', 'remove', '--force', target], {
    allowFailure: true,
  });

  await git(repo, ['worktree', 'add', '--quiet', target, options.branch]);

  options.onEvent?.(`Worktree ready at ${target}`);

  return {
    delivery: 'worktree',
    branch: options.branch,
    headCommit: head,
    worktreePath: target,
  };
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? 'repo';
}

function commitMessage(options: DeliverOptions): string {
  const subject = `${options.issueKey}: ${options.issueTitle}`.slice(0, 72);
  return [subject, '', options.summary].join('\n');
}
