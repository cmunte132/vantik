/**
 * The git side of a local run: a worktree of the person's checkout, on its own
 * branch, so the run never touches the checkout the person is working in.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** `~/.vantik`, or `$VANTIK_HOME`. Worktrees and run directories live here. */
type Env = Record<string, string | undefined>;

export function vantikHome(env: Env = process.env): string {
  return env.VANTIK_HOME || path.join(homedir(), '.vantik');
}

/** A repository name or issue key as one safe path segment. */
export function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[-]+$/g, '');
  return cleaned || 'unnamed';
}

/** `<home>/worktrees/<repo fullName>/<issue key>` */
export function worktreePathFor(
  home: string,
  repoFullName: string,
  issueKey: string,
): string {
  return path.join(
    home,
    'worktrees',
    sanitizeSegment(repoFullName),
    sanitizeSegment(issueKey),
  );
}

/** `<home>/runs/<run id>`, where the policy, context and outbox are seeded. */
export function runDirFor(home: string, runId: string): string {
  return path.join(home, 'runs', sanitizeSegment(runId));
}

export type GitRunner = (
  cwd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

async function gitOk(git: GitRunner, cwd: string, args: string[]) {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

/**
 * Creates the run's worktree, or finds the one a previous run left.
 *
 * The branch starts at `baseRef`, or at HEAD when the ref is missing. A branch
 * that exists from an earlier run is reused: it is checked out in a fresh
 * worktree and carries on from its own tip.
 */
export async function createWorktree(
  input: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
  },
  git: GitRunner = runGit,
): Promise<WorktreeInfo> {
  const { repoPath, worktreePath, branch, baseRef } = input;

  const resolve = async (ref: string) => {
    const result = await git(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const baseCommit =
    (await resolve(baseRef)) ?? (await resolve('HEAD')) ?? null;
  if (!baseCommit) {
    throw new Error(`${repoPath} has no commits to branch from.`);
  }

  // A worktree from an earlier run, still registered: keep it, so work the
  // person did there is not lost.
  const listed = await gitOk(git, repoPath, [
    'worktree',
    'list',
    '--porcelain',
  ]);
  const existing = parseWorktreeList(listed).find(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (existing) {
    if (existing.branch !== branch) {
      throw new Error(
        `${worktreePath} is a worktree on ${existing.branch ?? 'a detached HEAD'}, not ${branch}. Remove it with git worktree remove, then dispatch again.`,
      );
    }
    return {
      path: worktreePath,
      branch,
      baseCommit: await baseFor(git, repoPath, branch, baseCommit),
    };
  }

  const branchExists =
    (
      await git(repoPath, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ])
    ).code === 0;

  if (branchExists) {
    await gitOk(git, repoPath, ['worktree', 'add', worktreePath, branch]);
    return {
      path: worktreePath,
      branch,
      baseCommit: await baseFor(git, repoPath, branch, baseCommit),
    };
  }

  await gitOk(git, repoPath, [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    baseCommit,
  ]);
  return { path: worktreePath, branch, baseCommit };
}

/** Where an existing branch left the base: the merge base, else the base ref. */
async function baseFor(
  git: GitRunner,
  repoPath: string,
  branch: string,
  baseCommit: string,
): Promise<string> {
  const mergeBase = await git(repoPath, ['merge-base', branch, baseCommit]);
  return mergeBase.code === 0 && mergeBase.stdout.trim()
    ? mergeBase.stdout.trim()
    : baseCommit;
}

export function parseWorktreeList(
  porcelain: string,
): Array<{ path: string; branch: string | null }> {
  return porcelain
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n');
      const wt = lines.find((l) => l.startsWith('worktree '));
      const br = lines.find((l) => l.startsWith('branch '));
      return wt
        ? {
            path: wt.slice('worktree '.length),
            branch: br ? br.slice('branch refs/heads/'.length) : null,
          }
        : null;
    })
    .filter(
      (entry): entry is { path: string; branch: string | null } =>
        entry !== null,
    );
}

/** Files the connector writes into the worktree. They are never committed. */
export const RUN_FILES = ['.omp/mcp.json'];

/**
 * Adds the connector's files to the repository's exclude file, so `git status`
 * does not show them. Git shares this file between a checkout and its
 * worktrees; the entries are anchored to each worktree root.
 */
export async function excludeRunFiles(
  worktreePath: string,
  git: GitRunner = runGit,
): Promise<void> {
  const located = await gitOk(git, worktreePath, [
    'rev-parse',
    '--git-path',
    'info/exclude',
  ]);
  const file = path.resolve(worktreePath, located);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = RUN_FILES.map((name) => `/${name}`).filter(
    (line) => !existing.split('\n').includes(line),
  );
  if (missing.length > 0) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`,
    );
  }
}

export interface WorktreeResult {
  /** The branch with the run's commits, or null when nothing changed. */
  branch: string | null;
  headCommit: string | null;
}

/**
 * Commits whatever the agent left uncommitted, then reports the result. The
 * commit uses the person's own git identity. Hooks are skipped: the run's
 * checks already ran, and a hook that wants a terminal would hang it.
 */
export async function commitWorktree(
  input: {
    worktreePath: string;
    branch: string;
    baseCommit: string;
    message: string;
  },
  git: GitRunner = runGit,
): Promise<WorktreeResult> {
  const { worktreePath, branch, baseCommit, message } = input;

  // The connector's own files are never part of the work.
  const pathspec = ['--', '.', ...RUN_FILES.map((file) => `:(exclude)${file}`)];
  const status = await gitOk(git, worktreePath, [
    'status',
    '--porcelain',
    ...pathspec,
  ]);
  if (status) {
    await gitOk(git, worktreePath, ['add', '-A']);
    // Unstage them again: a tracked copy is staged by `add -A`.
    await git(worktreePath, ['reset', '-q', '--', ...RUN_FILES]);
    const staged = await git(worktreePath, ['diff', '--cached', '--quiet']);
    if (staged.code !== 0) {
      await gitOk(git, worktreePath, ['commit', '--no-verify', '-m', message]);
    }
  }

  const head = await gitOk(git, worktreePath, ['rev-parse', 'HEAD']);
  return head === baseCommit
    ? { branch: null, headCommit: null }
    : { branch, headCommit: head };
}
