import { execFileSync } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { localHead, readLocalFile, type RunGit } from './git-files';

/**
 * Reading a local repository's files for citations, through git.
 *
 * Against a real repository in a temporary directory rather than a mocked
 * git: what is being tested is what git answers, and a mock would only prove
 * that the mock agrees with the code.
 */
describe('local repository files', () => {
  let root: string;
  let first: string;
  let second: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vantik-cite-'));
    git('init', '-q', '-b', 'main');
    await writeFile(join(root, 'a.ts'), 'one\ntwo\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    first = git('rev-parse', 'HEAD');

    await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\n');
    await writeFile(join(root, 'b.ts'), 'bee\n');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'c.ts'), 'sea\n');
    git('add', '.');
    git('commit', '-q', '-m', 'second');
    second = git('rev-parse', 'HEAD');

    // Uncommitted edits are not what a commit says.
    await writeFile(join(root, 'a.ts'), 'edited in the working tree\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('[KG-2.3] reads a file as it was at the cited commit, not as the working tree has it', async () => {
    await expect(readLocalFile(root, 'a.ts', first)).resolves.toEqual({
      content: 'one\ntwo\n',
    });
    await expect(
      readLocalFile(root, './a.ts', second.slice(0, 7)),
    ).resolves.toEqual({ content: 'one\ntwo\nthree\n' });
  });

  it('[KG-2.3] answers missing for a path the commit does not have, or a commit the repository does not have', async () => {
    await expect(readLocalFile(root, 'b.ts', first)).resolves.toEqual({
      missing: true,
    });
    await expect(
      readLocalFile(root, 'a.ts', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).resolves.toEqual({ missing: true });
  });

  it('[KG-2.3] answers missing for a folder, which has no lines to cite', async () => {
    await expect(readLocalFile(root, 'src', second)).resolves.toEqual({
      missing: true,
    });
    await expect(readLocalFile(root, 'src/c.ts', second)).resolves.toEqual({
      content: 'sea\n',
    });
  });

  it('[KG-2.3] answers unknown, never missing, when the checkout cannot be asked', async () => {
    await expect(readLocalFile(null, 'a.ts', first)).resolves.toMatchObject({
      unknown: true,
    });
    await expect(
      readLocalFile(join(root, 'no-such-dir'), 'a.ts', first),
    ).resolves.toMatchObject({ unknown: true });

    const noGit: RunGit = async () => ({
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
    });

    await expect(readLocalFile(root, 'a.ts', first, noGit)).resolves.toEqual({
      unknown: true,
      reason: 'git is not installed on this server',
    });

    // What execFile reports when its timeout kills git.
    const stuck: RunGit = async () => ({
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('Command failed'), { killed: true }),
    });

    await expect(readLocalFile(root, 'a.ts', first, stuck)).resolves.toEqual({
      unknown: true,
      reason: 'git took too long to answer',
    });
  });

  it('[KG-2.3] never hands git a path outside the repository or a ref that is not a commit', async () => {
    const run = jest.fn<ReturnType<RunGit>, Parameters<RunGit>>();

    for (const [path, ref] of [
      ['../outside.ts', first],
      ['/etc/passwd', first],
      ['.', first],
      ['src/.', first],
      ['a.ts', 'HEAD'],
      ['a.ts', '--output=/tmp/x'],
    ]) {
      await expect(readLocalFile(root, path, ref, run)).resolves.toMatchObject({
        unknown: true,
      });
    }

    expect(run).not.toHaveBeenCalled();
  });

  it('[KG-2.3] resolves the head of the default branch', async () => {
    await expect(localHead(root)).resolves.toEqual({ sha: second });
    await expect(localHead(null)).resolves.toMatchObject({ unknown: true });
  });
});
