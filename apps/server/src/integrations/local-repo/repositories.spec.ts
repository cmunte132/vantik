import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { BadRequestException } from '@nestjs/common';
import { createIntegrationAccount } from 'integrations/utils';

import {
  inspectPath,
  repositoryRoot,
  setRepositoryGitIssues,
} from './repositories';

jest.mock('integrations/utils', () => ({
  createIntegrationAccount: jest.fn().mockResolvedValue({}),
}));

/**
 * A path names a directory on the machine that runs the server, so the check on
 * it is the whole of the security of this feature. These tests use real
 * directories rather than a mocked `fs`: the thing being tested is what happens
 * on a filesystem, and a mock would only prove that the mock agrees.
 */
describe('inspectPath', () => {
  let root: string;
  let repository: string;
  const originalRoot = process.env.LOCAL_REPO_ROOT;

  beforeAll(async () => {
    // `resolve` because macOS gives /var, which is a symlink to /private/var,
    // and the function resolves what it is given before it compares.
    root = resolve(await mkdtemp(join(tmpdir(), 'vantik-repos-')));
    repository = join(root, 'checkout');

    await mkdir(join(repository, '.git'), { recursive: true });
    await mkdir(join(root, 'not-a-repository'), { recursive: true });
    await writeFile(join(root, 'a-file'), 'not a directory');

    process.env.LOCAL_REPO_ROOT = root;
  });

  afterAll(async () => {
    process.env.LOCAL_REPO_ROOT = originalRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a git checkout inside the root', async () => {
    await expect(inspectPath(repository)).resolves.toBe(repository);
  });

  it('accepts a worktree, whose .git is a file', async () => {
    const worktree = join(root, 'worktree');

    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere');

    await expect(inspectPath(worktree)).resolves.toBe(worktree);
  });

  it('refuses a relative path', async () => {
    await expect(inspectPath('some/repo')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an empty path', async () => {
    await expect(inspectPath('   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a directory that is not a git repository', async () => {
    await expect(
      inspectPath(join(root, 'not-a-repository')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a file', async () => {
    await expect(inspectPath(join(root, 'a-file'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe('the root', () => {
    it('refuses a path outside it', async () => {
      await expect(inspectPath('/etc')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    /**
     * The comparison happens after `resolve`, so climbing out with `..` is the
     * same as naming the outside directly.
     */
    it('refuses a path that climbs out with ..', async () => {
      await expect(
        inspectPath(join(repository, '..', '..', '..', 'etc')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * The prefix ends in a separator, so a sibling whose name merely starts
     * with the root's name is outside it.
     */
    it('refuses a sibling directory with the root as a name prefix', async () => {
      await expect(inspectPath(`${root}-other/repo`)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses the root itself, which holds repositories rather than being one', async () => {
      await expect(inspectPath(root)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    /**
     * A refused path must not say whether it existed. The containment check
     * runs before anything reads the disk, so the message is about the root for
     * a real directory and an imaginary one alike.
     */
    it('says the same thing about a path outside it whether or not it exists', async () => {
      const real = inspectPath('/etc').catch((error) => error.message);
      const imaginary = inspectPath('/etc/nothing-here-at-all').catch(
        (error) => error.message,
      );

      expect(await real).toBe(await imaginary);
      expect(await real).toContain(root);
    });
  });
});

describe('repositoryRoot', () => {
  const originalRoot = process.env.LOCAL_REPO_ROOT;

  afterEach(() => {
    process.env.LOCAL_REPO_ROOT = originalRoot;
  });

  it('uses LOCAL_REPO_ROOT when it is set', () => {
    process.env.LOCAL_REPO_ROOT = '/srv/repos';

    expect(repositoryRoot()).toBe('/srv/repos');
  });

  /**
   * The fallback is a real fence and not an open door. Whatever it is, it is
   * not the filesystem root, which is what "any absolute path" used to mean.
   */
  it('falls back to a directory rather than to the whole disk', () => {
    delete process.env.LOCAL_REPO_ROOT;

    const fallback = repositoryRoot();

    expect(fallback).not.toBe('/');
    expect(fallback.length).toBeGreaterThan(1);
  });
});

describe('setRepositoryGitIssues', () => {
  const written = createIntegrationAccount as jest.Mock;

  function context(repositories: object[]) {
    return {
      definitions: { get: jest.fn().mockResolvedValue({ id: 'definition-1' }) },
      account: {
        byDefinition: jest
          .fn()
          .mockResolvedValue({ settings: { repositories } }),
      },
      workspace: {
        teams: jest.fn().mockResolvedValue([
          { id: 'team-a', identifier: 'ENG', deleted: null },
          { id: 'team-b', identifier: 'OPS', deleted: null },
          { id: 'team-c', identifier: 'ENG', deleted: null },
          { id: 'team-gone', identifier: 'OLD', deleted: new Date() },
        ]),
      },
    } as never;
  }

  const repository = {
    id: 'repo-1',
    fullName: 'app',
    path: '/home/app',
    addedAt: '2026-10-01T00:00:00Z',
  };
  const parameters = (teamIds: string[]) => ({
    workspaceId: 'workspace-1',
    userId: 'user-1',
    repositoryId: 'repo-1',
    teamIds,
  });

  beforeEach(() => written.mockClear());

  it('stores the teams in the entry of that repository only', async () => {
    const other = { ...repository, id: 'repo-2' };
    const result = await setRepositoryGitIssues(
      context([repository, other]),
      parameters(['team-a', 'team-b', 'team-a']),
    );

    expect(result.gitIssues).toEqual({ teamIds: ['team-a', 'team-b'] });
    expect(written.mock.calls[0][1].settings.repositories).toEqual([
      { ...repository, gitIssues: { teamIds: ['team-a', 'team-b'] } },
      other,
    ]);
  });

  it('turns the mirror off with an empty list', async () => {
    const result = await setRepositoryGitIssues(
      context([{ ...repository, gitIssues: { teamIds: ['team-a'] } }]),
      parameters([]),
    );

    expect(result).not.toHaveProperty('gitIssues');
    expect(
      written.mock.calls[0][1].settings.repositories[0],
    ).not.toHaveProperty('gitIssues');
  });

  it('refuses two teams that share an identifier', async () => {
    await expect(
      setRepositoryGitIssues(
        context([repository]),
        parameters(['team-a', 'team-c']),
      ),
    ).rejects.toThrow(/identifier ENG/);
    expect(written).not.toHaveBeenCalled();
  });

  it('refuses a team that is not in the workspace', async () => {
    await expect(
      setRepositoryGitIssues(context([repository]), parameters(['nobody'])),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setRepositoryGitIssues(
        context([repository]),
        parameters(['team-a', 'nobody']),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drops a deleted team of the workspace and keeps the rest', async () => {
    const result = await setRepositoryGitIssues(
      context([
        { ...repository, gitIssues: { teamIds: ['team-a', 'team-gone'] } },
      ]),
      parameters(['team-a', 'team-gone', 'team-b']),
    );

    expect(result.gitIssues).toEqual({ teamIds: ['team-a', 'team-b'] });
  });

  it('refuses a repository that the workspace does not have', async () => {
    await expect(
      setRepositoryGitIssues(context([]), parameters(['team-a'])),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
