import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anonymousRemote } from 'modules/git/git-command';

import {
  gitIssueRemote,
  HostRefusedPushError,
  INBOX_PREFIX,
  SNAPSHOT_REF,
} from './issue-remote';

/**
 * The traffic between the mirror and its source, with two real repositories.
 * The source is a checkout, as a person's repository is. The mirror is bare.
 */

let root: string;
let source: string;
let mirror: string;

function git(cwd: string, ...args: string[]): string {
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

function remote() {
  const url = anonymousRemote(source);

  return gitIssueRemote(mirror, { fetch: url, push: url }, (work) => work());
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vantik-issue-remote-'));
  source = join(root, 'source');
  mirror = join(root, 'mirror.git');
  git(root, 'init', '-q', '-b', 'main', source);
  await writeFile(join(source, 'app.js'), 'x\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'code');
  git(root, 'init', '-q', '--bare', mirror);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

jest.setTimeout(60_000);

describe('gitIssueRemote', () => {
  it('fetches from a source that has no issue refs yet', async () => {
    await remote().fetchRefs();

    expect(git(mirror, 'for-each-ref')).toBe('');
  });

  it('copies the snapshot and the inbox refs, and no branch', async () => {
    const head = git(source, 'rev-parse', 'HEAD');

    git(source, 'update-ref', SNAPSHOT_REF, head);
    git(source, 'update-ref', `${INBOX_PREFIX}one`, head);

    await remote().fetchRefs();

    expect(git(mirror, 'for-each-ref', '--format=%(refname)')).toBe(
      `${INBOX_PREFIX}one\n${SNAPSHOT_REF}`,
    );
  });

  it('removes what the source no longer has, and only under refs/vantik', async () => {
    const head = git(source, 'rev-parse', 'HEAD');

    git(source, 'update-ref', SNAPSHOT_REF, head);
    git(source, 'update-ref', `${INBOX_PREFIX}one`, head);
    await remote().fetchRefs();

    git(mirror, 'update-ref', 'refs/heads/kept', head);
    git(source, 'update-ref', '-d', `${INBOX_PREFIX}one`);
    git(source, 'update-ref', '-d', SNAPSHOT_REF);
    await remote().fetchRefs();

    expect(git(mirror, 'for-each-ref', '--format=%(refname)')).toBe(
      'refs/heads/kept',
    );
  });

  it('pushes the snapshot only while the source ref is where the pass read it', async () => {
    const head = git(source, 'rev-parse', 'HEAD');

    git(source, 'update-ref', SNAPSHOT_REF, head);
    await remote().fetchRefs();

    // The commits that the pass would push exist in the mirror only.
    const next = git(
      mirror,
      'commit-tree',
      '-p',
      head,
      '-m',
      'next',
      `${head}^{tree}`,
    );
    const other = git(
      mirror,
      'commit-tree',
      '-p',
      head,
      '-m',
      'other',
      `${head}^{tree}`,
    );

    // The pass expected no ref, and the source has one.
    expect(await remote().pushSnapshot(next, null)).toBe(false);
    // The pass expected a ref that is not the one at the source.
    expect(await remote().pushSnapshot(next, other)).toBe(false);
    expect(git(source, 'rev-parse', SNAPSHOT_REF)).toBe(head);

    expect(await remote().pushSnapshot(next, head)).toBe(true);
    expect(git(source, 'rev-parse', SNAPSHOT_REF)).toBe(next);
  });

  it('creates the snapshot ref when the pass expected none', async () => {
    const head = git(source, 'rev-parse', 'HEAD');

    await remote().fetchRefs();
    git(mirror, 'fetch', '-q', source, '+refs/heads/main:refs/heads/main');

    expect(await remote().pushSnapshot(head, null)).toBe(true);
    expect(git(source, 'rev-parse', SNAPSHOT_REF)).toBe(head);
  });

  it('deletes an inbox ref only while it is where the pass read it', async () => {
    const head = git(source, 'rev-parse', 'HEAD');
    const later = git(
      source,
      'commit-tree',
      '-p',
      head,
      '-m',
      'later',
      'HEAD^{tree}',
    );

    git(source, 'update-ref', `${INBOX_PREFIX}one`, later);

    expect(await remote().deleteInbox(`${INBOX_PREFIX}one`, head)).toBe(false);
    expect(git(source, 'rev-parse', `${INBOX_PREFIX}one`)).toBe(later);

    expect(await remote().deleteInbox(`${INBOX_PREFIX}one`, later)).toBe(true);
    expect(git(source, 'for-each-ref', INBOX_PREFIX)).toBe('');
  });

  describe('when the host refuses refs/vantik by its own rule', () => {
    beforeEach(() => {
      // A host that hides a ref namespace refuses each update to it. This is
      // the same answer as a protected ref or a token that cannot write.
      git(source, 'config', 'receive.hideRefs', 'refs/vantik');
    });

    it('says so, and does not report a lost race', async () => {
      const head = git(source, 'rev-parse', 'HEAD');

      await remote().fetchRefs();
      git(mirror, 'fetch', '-q', source, '+refs/heads/main:refs/heads/main');

      const refused = remote().pushSnapshot(head, null);

      await expect(refused).rejects.toBeInstanceOf(HostRefusedPushError);
      await expect(refused).rejects.toThrow(/refs\/vantik\/issues/);
      expect(git(source, 'for-each-ref', 'refs/vantik')).toBe('');
    });

    it('does not put the address of the host in the message', async () => {
      const head = git(source, 'rev-parse', 'HEAD');

      git(mirror, 'fetch', '-q', source, '+refs/heads/main:refs/heads/main');

      await expect(remote().pushSnapshot(head, null)).rejects.not.toThrow(
        source,
      );
    });
  });
});
