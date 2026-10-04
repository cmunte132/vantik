import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anonymousRemote, git } from './git-command';
import { type GitSource, type SourceRepo } from './git-source';
import { type ResolvedRepo } from './git-sources.service';
import { RepoMirrorService } from './repo-mirror.service';
import { LocalDirectorySource } from './sources/local-directory.source';

/**
 * Real repositories in a temporary directory, and real git. The mirror is
 * plain git and nothing else, so a fake would test the fake.
 */

let scratch: string;
let origin: string;
let service: RepoMirrorService;
const env = { ...process.env };

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

function commit(files: Record<string, string>, message = 'change'): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(origin, path, '..'), { recursive: true });
    writeFileSync(join(origin, path), content);
  }

  run(origin, 'add', '-A');
  run(origin, 'commit', '--quiet', '-m', message);

  return run(origin, 'rev-parse', 'HEAD');
}

function local(id = 'repo-1'): ResolvedRepo {
  const repo: SourceRepo = {
    workspaceId: 'ws',
    integrationAccountId: 'account-1',
    accountId: 'ws',
    externalRepoId: id,
    fullName: 'app',
    listing: { id, fullName: 'app', path: origin },
    config: {},
  };

  return { source: new LocalDirectorySource(), repo };
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mirror-spec-')));
  origin = join(scratch, 'home', 'app');
  mkdirSync(origin, { recursive: true });
  run(origin, 'init', '--quiet', '--initial-branch=main');

  process.env.LOCAL_REPO_ROOT = join(scratch, 'home');
  process.env.REPO_MIRROR_ROOT = join(scratch, 'mirrors');

  service = new RepoMirrorService();
});

afterEach(() => {
  process.env = { ...env };
  rmSync(scratch, { recursive: true, force: true });
});

describe('RepoMirrorService', () => {
  it('mirrors every branch into a bare repository the server owns', async () => {
    commit({ 'README.md': 'hello' });
    run(origin, 'branch', 'feature');

    const mirror = await service.sync(local());

    expect(mirror.path.startsWith(join(scratch, 'mirrors', 'account-1'))).toBe(
      true,
    );
    expect(run(mirror.path, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(
      run(mirror.path, 'for-each-ref', '--format=%(refname)').split('\n'),
    ).toEqual(['refs/heads/feature', 'refs/heads/main']);
  });

  it('takes main as the default even when a feature branch is checked out', async () => {
    commit({ 'README.md': 'hello' });
    run(origin, 'checkout', '--quiet', '-b', 'wip');
    commit({ 'README.md': 'unfinished' });

    const mirror = await service.sync(local());

    expect(mirror.defaultBranch).toBe('main');
    expect(run(mirror.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  });

  it('takes the HEAD the remote advertises when the source has no opinion', async () => {
    commit({ 'README.md': 'hello' });
    run(origin, 'branch', '-m', 'main', 'trunk');

    const source: GitSource = {
      slug: 'test',
      notifies: false,
      fetchRemote: async () => anonymousRemote(origin),
      pushRemote: async () => anonymousRemote(origin),
      location: () => origin,
    };

    const mirror = await service.sync({ source, repo: local().repo });

    expect(mirror.defaultBranch).toBe('trunk');
  });

  it('shares one fetch between callers that ask together', async () => {
    commit({ 'README.md': 'hello' });

    const source = new LocalDirectorySource();
    const fetchRemote = jest.spyOn(source, 'fetchRemote');
    const resolved = { source, repo: local().repo };

    await Promise.all([
      service.sync(resolved),
      service.sync(resolved),
      service.sync(resolved),
    ]);

    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it('does not fetch again inside the freshness window, and does after it', async () => {
    commit({ 'README.md': 'hello' });

    const source = new LocalDirectorySource();
    const fetchRemote = jest.spyOn(source, 'fetchRemote');
    const resolved = { source, repo: local().repo };

    await service.sync(resolved);
    await service.sync(resolved);
    expect(fetchRemote).toHaveBeenCalledTimes(1);

    await service.sync(resolved, 0);
    expect(fetchRemote).toHaveBeenCalledTimes(2);
  });

  it('reads a file at a commit, whatever is in the working directory', async () => {
    const sha = commit({ 'src/app.ts': 'export const a = 1;\n' });
    writeFileSync(join(origin, 'src/app.ts'), 'not committed');

    await expect(service.readFile(local(), 'src/app.ts', sha)).resolves.toEqual(
      {
        content: 'export const a = 1;\n',
      },
    );
  });

  it('fetches once more for a commit made after the last fetch', async () => {
    commit({ 'a.txt': 'one' });
    await service.sync(local());

    const later = commit({ 'a.txt': 'two' });

    await expect(service.readFile(local(), 'a.txt', later)).resolves.toEqual({
      content: 'two',
    });
  });

  it('says missing for a path the commit does not have, and for a folder', async () => {
    const sha = commit({ 'src/app.ts': 'x' });

    await expect(
      service.readFile(local(), 'src/gone.ts', sha),
    ).resolves.toEqual({
      missing: true,
    });
    await expect(service.readFile(local(), 'src', sha)).resolves.toEqual({
      missing: true,
    });
  });

  it('refuses a path that could leave the repository before git sees it', async () => {
    const sha = commit({ 'a.txt': 'x' });

    await expect(
      service.readFile(local(), '../secret', sha),
    ).resolves.toMatchObject({
      unknown: true,
      thisFileOnly: true,
    });
  });

  it('says unknown, not missing, when the source is gone', async () => {
    const sha = commit({ 'a.txt': 'x' });
    rmSync(origin, { recursive: true, force: true });

    await expect(
      service.readFile(local(), 'a.txt', sha),
    ).resolves.toMatchObject({
      unknown: true,
    });
  });

  it('[ENG-224] searches a commit for a fixed text, whatever its case, and not the working directory', async () => {
    const first = commit({ 'a.ts': 'one\ntwo\n' });
    const second = commit({ 'a.ts': 'one\ntwo\nthree\n' });
    writeFileSync(join(origin, 'a.ts'), 'edited\n');

    await expect(service.search(local(), 'THREE', second)).resolves.toEqual({
      matches: [{ path: 'a.ts', line: 3, text: 'three' }],
    });
    await expect(service.search(local(), 'three', first)).resolves.toEqual({
      matches: [],
    });
    // A pattern character is a character to find, not a pattern.
    await expect(service.search(local(), 'o.e', second)).resolves.toEqual({
      matches: [],
    });
    await expect(service.search(local(), 'edited', second)).resolves.toEqual({
      matches: [],
    });
  });

  it('[ENG-224] keeps a text that looks like an option a text to find', async () => {
    const sha = commit({ 'a.ts': 'one\n' });

    await expect(service.search(local(), '--help', sha)).resolves.toEqual({
      matches: [],
    });
    await expect(service.search(local(), '', sha)).resolves.toMatchObject({
      unknown: true,
    });
    await expect(service.search(local(), 'one', 'HEAD')).resolves.toMatchObject(
      { unknown: true },
    );
  });

  it('gives the head of the default branch', async () => {
    const sha = commit({ 'a.txt': 'x' });
    run(origin, 'checkout', '--quiet', '-b', 'wip');
    commit({ 'a.txt': 'y' });

    await expect(service.head(local())).resolves.toEqual({ sha });
  });

  it('checks out the tracked tree of a branch, without .git', async () => {
    const sha = commit({ 'a.txt': 'x', 'src/b.ts': 'y' });

    const checkout = await service.checkout(local());
    const archive = join(scratch, 'out.tar.gz');
    writeFileSync(archive, Buffer.from(checkout.archiveBase64, 'base64'));

    const listing = execFileSync('tar', ['-tzf', archive], {
      encoding: 'utf8',
    });

    expect(checkout).toMatchObject({ baseCommit: sha, baseBranch: 'main' });
    expect(listing).toContain('a.txt');
    expect(listing).toContain('src/b.ts');
    expect(listing).not.toContain('.git/');
  });

  it('lists committed folders, two levels deep, and marks projects', async () => {
    commit({
      'apps/server/package.json': '{}',
      'apps/server/src/main.ts': '',
      'apps/webapp/package.json': '{}',
      'packages/types/package.json': '{}',
      'service/go.mod': '',
      'service/cmd/main.go': '',
      'node_modules/x/index.js': '',
      '.github/workflows/ci.yml': '',
      'README.md': '',
    });
    mkdirSync(join(origin, 'uncommitted'));
    writeFileSync(join(origin, 'uncommitted', 'package.json'), '{}');

    await expect(service.folders(local())).resolves.toEqual([
      { path: 'apps/', isProject: false, depth: 1 },
      { path: 'apps/server/', isProject: true, depth: 2 },
      { path: 'apps/webapp/', isProject: true, depth: 2 },
      { path: 'packages/', isProject: false, depth: 1 },
      { path: 'packages/types/', isProject: true, depth: 2 },
      { path: 'service/', isProject: true, depth: 1 },
    ]);
  });

  it('gives a work clone at a commit that can push back to the source', async () => {
    const sha = commit({ 'a.txt': 'x' });
    const work = join(scratch, 'work');

    await service.workClone(local(), sha, work);

    expect(run(work, 'rev-parse', 'HEAD')).toBe(sha);

    writeFileSync(join(work, 'a.txt'), 'changed');
    run(work, 'add', '-A');
    execFileSync(
      'git',
      ['-c', 'user.name=A', '-c', 'user.email=a@b', 'commit', '-qm', 'agent'],
      {
        cwd: work,
      },
    );
    await git(['push', '--quiet', origin, 'HEAD:refs/heads/agent/ENG-1'], {
      cwd: work,
    });

    expect(run(origin, 'rev-parse', 'agent/ENG-1')).toBe(
      run(work, 'rev-parse', 'HEAD'),
    );
    expect(run(origin, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
