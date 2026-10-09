import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  commitWorktree,
  createWorktree,
  parseWorktreeList,
  runDirFor,
  sanitizeSegment,
  vantikHome,
  worktreePathFor,
} from './worktree';

describe('where a run lives on disk', () => {
  it('puts the worktree under the repository name and the issue key', () => {
    expect(worktreePathFor('/h/.vantik', 'acme/api-server', 'ENG-42')).toBe(
      '/h/.vantik/worktrees/acme-api-server/ENG-42',
    );
  });

  it('keeps a hostile name inside its directory', () => {
    const wt = worktreePathFor('/h', '../../etc/passwd', '..');
    expect(wt.startsWith('/h/worktrees/')).toBe(true);
    expect(wt).not.toContain('..');
    expect(sanitizeSegment('')).toBe('unnamed');
    expect(runDirFor('/h', 'run/1')).toBe('/h/runs/run-1');
  });

  it('honours VANTIK_HOME', () => {
    expect(vantikHome({ VANTIK_HOME: '/data/v' })).toBe('/data/v');
    expect(vantikHome({})).toMatch(/\.vantik$/);
  });

  it('reads the porcelain worktree list', () => {
    const list = [
      'worktree /r',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /w/x',
      'HEAD def',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeList(list)).toEqual([
      { path: '/r', branch: 'main' },
      { path: '/w/x', branch: null },
    ]);
  });
});

describe('a worktree of a real repository', () => {
  let root: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'vantik-wt-'));
    repo = path.join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'first');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('branches from the base ref, commits the agent work, and reports the head', async () => {
    const wtPath = worktreePathFor(root, 'acme/api', 'ENG-1');
    const wt = await createWorktree({
      repoPath: repo,
      worktreePath: wtPath,
      branch: 'agent/eng-1',
      baseRef: 'main',
    });

    expect(wt.baseCommit).toBe(git(repo, 'rev-parse', 'main'));
    expect(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'agent/eng-1',
    );

    const untouched = await commitWorktree({
      worktreePath: wtPath,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      message: 'ENG-1: nothing',
    });
    expect(untouched).toEqual({ branch: null, headCommit: null });

    writeFileSync(path.join(wtPath, 'b.txt'), 'b\n');
    const done = await commitWorktree({
      worktreePath: wtPath,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      message: 'ENG-1: add b',
    });
    expect(done.branch).toBe('agent/eng-1');
    expect(done.headCommit).toBe(git(wtPath, 'rev-parse', 'HEAD'));
    expect(git(repo, 'log', '-1', '--format=%s', 'agent/eng-1')).toBe(
      'ENG-1: add b',
    );
    // The checkout the person works in is untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('falls back to HEAD when the base ref is missing', async () => {
    const wt = await createWorktree({
      repoPath: repo,
      worktreePath: path.join(root, 'wt'),
      branch: 'agent/x',
      baseRef: 'origin/main',
    });
    expect(wt.baseCommit).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('reuses a branch from an earlier run in a fresh worktree', async () => {
    const first = await createWorktree({
      repoPath: repo,
      worktreePath: path.join(root, 'wt1'),
      branch: 'agent/x',
      baseRef: 'main',
    });
    writeFileSync(path.join(root, 'wt1', 'c.txt'), 'c\n');
    const committed = await commitWorktree({
      worktreePath: first.path,
      branch: 'agent/x',
      baseCommit: first.baseCommit,
      message: 'c',
    });
    git(repo, 'worktree', 'remove', '--force', path.join(root, 'wt1'));

    const second = await createWorktree({
      repoPath: repo,
      worktreePath: path.join(root, 'wt2'),
      branch: 'agent/x',
      baseRef: 'main',
    });
    expect(second.baseCommit).toBe(first.baseCommit);
    expect(git(second.path, 'rev-parse', 'HEAD')).toBe(committed.headCommit);
    expect(readFileSync(path.join(second.path, 'c.txt'), 'utf8')).toBe('c\n');
  });
});
