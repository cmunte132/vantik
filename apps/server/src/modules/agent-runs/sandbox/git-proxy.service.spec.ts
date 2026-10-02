import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GitSource } from 'modules/git/git-source';
import {
  GitSourcesService,
  type RepoRef,
} from 'modules/git/git-sources.service';
import { RepoMirrorService } from 'modules/git/repo-mirror.service';
import { LocalDirectorySource } from 'modules/git/sources/local-directory.source';

import { GitProxyService } from './git-proxy.service';

/**
 * A run's whole trip through git, against a real directory: the checkout
 * comes from the server's mirror, and the branch goes back into the directory
 * the person works in.
 */

let scratch: string;
let origin: string;
const env = { ...process.env };

const SOURCE = {
  integrationAccountId: 'account-1',
  externalRepoId: 'repo-1',
  fullName: 'app',
};

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Person',
      GIT_AUTHOR_EMAIL: 'person@example.com',
      GIT_COMMITTER_NAME: 'Person',
      GIT_COMMITTER_EMAIL: 'person@example.com',
    },
  }).trim();
}

function build(
  source: GitSource = new LocalDirectorySource(),
): GitProxyService {
  const require = jest.fn(async (ref: RepoRef) => ({
    source,
    repo: {
      workspaceId: ref.workspaceId,
      integrationAccountId: 'account-1',
      accountId: ref.workspaceId,
      externalRepoId: 'repo-1',
      fullName: 'app',
      listing: { id: 'repo-1', fullName: 'app', path: origin },
      config: {},
    },
  }));

  return new GitProxyService(
    { require } as unknown as GitSourcesService,
    new RepoMirrorService(),
  );
}

/** What the guest hands back: its working tree, as a gzipped tar in base64. */
function treeOf(files: Record<string, string>): string {
  const tree = join(scratch, `tree-${Date.now()}-${Math.random()}`);

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(tree, path, '..'), { recursive: true });
    writeFileSync(join(tree, path), content);
  }

  const archive = `${tree}.tar.gz`;
  execFileSync('tar', ['-czf', archive, '-C', tree, '.']);

  return readFileSync(archive).toString('base64');
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'git-proxy-spec-')));
  origin = join(scratch, 'home', 'app');
  mkdirSync(join(origin, 'src'), { recursive: true });
  run(origin, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(origin, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(origin, 'README.md'), 'app\n');
  run(origin, 'add', '-A');
  run(origin, 'commit', '--quiet', '-m', 'first');

  process.env.LOCAL_REPO_ROOT = join(scratch, 'home');
  process.env.REPO_MIRROR_ROOT = join(scratch, 'mirrors');
});

afterEach(() => {
  process.env = { ...env };
  rmSync(scratch, { recursive: true, force: true });
});

describe('GitProxyService with a local directory', () => {
  it('checks out the default branch from the mirror, not the working tree', async () => {
    run(origin, 'checkout', '--quiet', '-b', 'wip');
    writeFileSync(join(origin, 'src', 'a.ts'), 'unfinished');

    const checkout = await build().materializeCheckout({
      workspaceId: 'ws',
      source: SOURCE,
    });

    expect(checkout.baseBranch).toBe('main');
    expect(checkout.baseCommit).toBe(run(origin, 'rev-parse', 'main'));
  });

  it('pushes the agent’s branch into the directory, and leaves the person’s checkout alone', async () => {
    const proxy = build();
    const checkout = await proxy.materializeCheckout({
      workspaceId: 'ws',
      source: SOURCE,
    });

    run(origin, 'checkout', '--quiet', '-b', 'wip');

    const pushed = await proxy.pushWorkTree({
      workspaceId: 'ws',
      source: SOURCE,
      branch: 'agent/eng-1',
      baseBranch: checkout.baseBranch,
      baseCommit: checkout.baseCommit,
      treeBase64: treeOf({
        'src/a.ts': 'export const a = 2;\n',
        'src/b.ts': 'export const b = 1;\n',
      }),
      commitMessage: 'ENG-1: Change a',
      issueKey: 'ENG-1',
      issueTitle: 'Change a',
      summary: 'Changed a.',
    });

    expect(pushed).toMatchObject({ branch: 'agent/eng-1', delivery: 'branch' });
    expect(pushed?.prUrl).toBeUndefined();
    expect(run(origin, 'branch', '--list', 'agent/eng-1')).toContain(
      'agent/eng-1',
    );
    expect(run(origin, 'show', 'agent/eng-1:src/a.ts')).toBe(
      'export const a = 2;',
    );
    // README.md was not in the tree the guest returned, so it is deleted.
    expect(run(origin, 'ls-tree', '--name-only', '-r', 'agent/eng-1')).toBe(
      'src/a.ts\nsrc/b.ts',
    );
    expect(run(origin, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wip');
  });

  it('keeps a tracked file under a generated directory the guest left out', async () => {
    mkdirSync(join(origin, 'coverage'));
    writeFileSync(join(origin, 'coverage', 'badge.svg'), '<svg/>\n');
    mkdirSync(join(origin, 'vendor', 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(origin, 'vendor', 'node_modules', 'x', 'i.js'), 'x\n');
    run(origin, 'add', '-A');
    run(origin, 'commit', '--quiet', '-m', 'track generated names');

    const proxy = build();
    const checkout = await proxy.materializeCheckout({
      workspaceId: 'ws',
      source: SOURCE,
    });

    // What the guest packs: everything but the generated directories.
    const pushed = await proxy.pushWorkTree({
      workspaceId: 'ws',
      source: SOURCE,
      branch: 'agent/eng-1',
      baseBranch: checkout.baseBranch,
      baseCommit: checkout.baseCommit,
      treeBase64: treeOf({
        'src/a.ts': 'export const a = 2;\n',
        'README.md': 'app\n',
      }),
      commitMessage: 'ENG-1',
      issueKey: 'ENG-1',
      issueTitle: 'x',
      summary: 'x',
    });

    expect(pushed?.branch).toBe('agent/eng-1');
    expect(run(origin, 'diff', '--name-status', 'main', 'agent/eng-1')).toBe(
      'M\tsrc/a.ts',
    );
  });

  it('takes the next free branch name rather than overwrite one', async () => {
    const proxy = build();
    const checkout = await proxy.materializeCheckout({
      workspaceId: 'ws',
      source: SOURCE,
    });
    run(origin, 'branch', 'agent/eng-1');

    const pushed = await proxy.pushWorkTree({
      workspaceId: 'ws',
      source: SOURCE,
      branch: 'agent/eng-1',
      baseBranch: checkout.baseBranch,
      baseCommit: checkout.baseCommit,
      treeBase64: treeOf({ 'src/a.ts': 'changed', 'README.md': 'app\n' }),
      commitMessage: 'ENG-1',
      issueKey: 'ENG-1',
      issueTitle: 'x',
      summary: 'x',
    });

    expect(pushed?.branch).toBe('agent/eng-1-2');
  });

  it('pushes nothing when the tree is the one it started from', async () => {
    const proxy = build();
    const checkout = await proxy.materializeCheckout({
      workspaceId: 'ws',
      source: SOURCE,
    });

    const pushed = await proxy.pushWorkTree({
      workspaceId: 'ws',
      source: SOURCE,
      branch: 'agent/eng-1',
      baseBranch: checkout.baseBranch,
      baseCommit: checkout.baseCommit,
      treeBase64: treeOf({
        'src/a.ts': 'export const a = 1;\n',
        'README.md': 'app\n',
      }),
      commitMessage: 'ENG-1',
      issueKey: 'ENG-1',
      issueTitle: 'x',
      summary: 'x',
    });

    expect(pushed).toBeUndefined();
    expect(run(origin, 'branch', '--list', 'agent/*')).toBe('');
  });

  it('commits as the source’s bot account, with the delegating person as co-author', async () => {
    const bot: GitSource = Object.assign(new LocalDirectorySource(), {
      commitAuthor: () => ({
        name: 'Vantik Bot',
        email: 'vantik-bot@noreply.forgejo.example.com',
      }),
    });
    const proxy = build(bot);
    const checkout = await proxy.materializeCheckout({
      workspaceId: 'ws',
      source: SOURCE,
    });

    await proxy.pushWorkTree({
      workspaceId: 'ws',
      source: SOURCE,
      branch: 'agent/eng-1',
      baseBranch: checkout.baseBranch,
      baseCommit: checkout.baseCommit,
      treeBase64: treeOf({ 'src/a.ts': 'export const a = 2;\n' }),
      commitMessage: 'ENG-1: Change a',
      issueKey: 'ENG-1',
      issueTitle: 'Change a',
      summary: 'Changed a.',
      coAuthor: { name: 'Ada Person', email: 'ada@example.com' },
    });

    expect(run(origin, 'log', '-1', '--format=%an <%ae>', 'agent/eng-1')).toBe(
      'Vantik Bot <vantik-bot@noreply.forgejo.example.com>',
    );
    expect(run(origin, 'log', '-1', '--format=%B', 'agent/eng-1')).toBe(
      'ENG-1: Change a\n\nCo-authored-by: Ada Person <ada@example.com>',
    );
  });

  it('commits as the agent when the source names no bot account', async () => {
    const proxy = build();
    const checkout = await proxy.materializeCheckout({
      workspaceId: 'ws',
      source: SOURCE,
    });

    await proxy.pushWorkTree({
      workspaceId: 'ws',
      source: SOURCE,
      branch: 'agent/eng-1',
      baseBranch: checkout.baseBranch,
      baseCommit: checkout.baseCommit,
      treeBase64: treeOf({ 'src/a.ts': 'export const a = 2;\n' }),
      commitMessage: 'ENG-1: Change a',
      issueKey: 'ENG-1',
      issueTitle: 'Change a',
      summary: 'Changed a.',
    });

    expect(
      run(origin, 'log', '-1', '--format=%an <%ae>%n%B', 'agent/eng-1'),
    ).toBe('Vantik Agent <agent@vantik.local>\nENG-1: Change a');
  });
});
