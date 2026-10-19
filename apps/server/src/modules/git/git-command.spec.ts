import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, gitBytes, localTransportArgs } from './git-command';

describe('git', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'git-command-spec-'));
    execFileSync('git', ['init', '-q', '-b', 'main', directory]);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('runs no hook and no fsmonitor command of the repository', async () => {
    const marker = join(directory, 'marker');

    writeFileSync(
      join(directory, '.git/hooks/reference-transaction'),
      `#!/bin/sh\ntouch ${marker}\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(directory, 'file'), 'x');
    execFileSync('git', ['config', 'core.fsmonitor', `touch ${marker}; echo`], {
      cwd: directory,
    });

    const identity = {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };

    // A commit moves a ref, which runs `reference-transaction`, and `status`
    // reads the index, which asks the fsmonitor command.
    await git(['add', 'file'], { cwd: directory });
    await git(['commit', '-q', '-m', 'x'], { cwd: directory, env: identity });
    await git(['status', '--porcelain'], { cwd: directory });

    expect(existsSync(marker)).toBe(false);
  });

  it('gives standard input to the command, and accepts a listed exit code', async () => {
    const { stdout, code } = await gitBytes(['cat-file', '--batch-check'], {
      cwd: directory,
      input: 'HEAD\n',
    });

    expect(stdout.toString()).toContain('missing');
    expect(code).toBe(0);

    const found = await gitBytes(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: directory,
      okCodes: [1],
    });

    expect(found.code).toBe(1);
  });

  /* eslint-disable turbo/no-undeclared-env-vars -- GIT_DIR is set on purpose, to prove that git ignores it. */
  it('ignores the repository that a parent git process set in the environment', async () => {
    const before = process.env.GIT_DIR;

    process.env.GIT_DIR = join(tmpdir(), 'not-a-repository');

    try {
      await expect(
        git(['rev-parse', '--git-dir'], { cwd: directory }),
      ).resolves.toBe('.git\n');
    } finally {
      if (before === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = before;
      }
    }
  });
  /* eslint-enable turbo/no-undeclared-env-vars */
});

describe('localTransportArgs', () => {
  it('gives a helper without hooks for a path and for a file URL', () => {
    for (const url of ['/home/me/app', 'file:///home/me/app']) {
      const [argument] = localTransportArgs(url, 'receive-pack');

      expect(argument).toMatch(/^--receive-pack=git /);
      expect(argument).toContain('core.hooksPath=/dev/null');
      expect(argument).toContain('core.fsmonitor=false');
      expect(argument).toContain('core.alternateRefsCommand=true');
      expect(argument).toContain('receive.autogc=false');
      expect(argument).toContain('gc.auto=0');
      expect(argument).toContain('maintenance.auto=false');
      expect(argument.endsWith(' receive-pack')).toBe(true);
    }

    expect(localTransportArgs('/home/me/app', 'upload-pack')[0]).toMatch(
      /^--upload-pack=git .* upload-pack$/,
    );
  });

  it('gives nothing for a remote that is not a local path', () => {
    expect(
      localTransportArgs('https://example.com/a.git', 'receive-pack'),
    ).toEqual([]);
    expect(localTransportArgs('git@example.com:a.git', 'upload-pack')).toEqual(
      [],
    );
  });
});
