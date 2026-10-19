import { ConflictException, ForbiddenException } from '@nestjs/common';
import { setRepositoryGitIssues } from 'integrations/local-repo/repositories';

import { resolveAdminWorkspaceId } from 'common/workspace-access';

import { LocalRepoService } from './local-repo.service';

jest.mock('common/workspace-access', () => ({
  resolveAdminWorkspaceId: jest.fn(),
}));
jest.mock('integrations/local-repo/repositories', () => ({
  ...jest.requireActual('integrations/local-repo/repositories'),
  setRepositoryGitIssues: jest.fn().mockResolvedValue({ id: 'repo-1' }),
}));

describe('LocalRepoService.setGitIssues', () => {
  const admin = resolveAdminWorkspaceId as jest.Mock;
  const write = setRepositoryGitIssues as jest.Mock;
  const path = '/home/app';
  const repository = (id: string, teamIds?: string[]) => ({
    id,
    fullName: 'app',
    path,
    addedAt: '2026-10-01T00:00:00Z',
    ...(teamIds ? { gitIssues: { teamIds } } : {}),
  });

  /** The account of this workspace, and the accounts that the pass lists. */
  function setUp(
    own: Array<ReturnType<typeof repository>>,
    listed: Array<{ id: string; workspaceId: string; repositories: object[] }>,
  ) {
    const prisma = {
      integrationAccount: {
        findMany: jest.fn().mockResolvedValue(
          listed.map(({ id, workspaceId, repositories }) => ({
            id,
            workspaceId,
            settings: { repositories },
          })),
        ),
      },
    };
    const ctx = {
      definitions: { get: jest.fn().mockResolvedValue({ id: 'definition-1' }) },
      account: {
        byDefinition: jest.fn().mockResolvedValue({
          id: 'account-1',
          settings: { repositories: own },
        }),
      },
    };

    return new LocalRepoService(
      prisma as never,
      { build: jest.fn().mockReturnValue(ctx) } as never,
    );
  }

  const service = setUp([repository('repo-1')], []);

  beforeEach(() => {
    admin.mockReset();
    write.mockClear();
  });

  it('writes for an admin of the workspace, in the workspace that the check named', async () => {
    admin.mockResolvedValue('workspace-2');

    await service.setGitIssues('workspace-1', 'user-1', 'repo-1', ['team-a']);

    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'workspace-2',
        repositoryId: 'repo-1',
        teamIds: ['team-a'],
      }),
    );
  });

  it('writes nothing for a member who is not an admin', async () => {
    admin.mockRejectedValue(new ForbiddenException());

    await expect(
      service.setGitIssues('workspace-1', 'user-1', 'repo-1', ['team-a']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(write).not.toHaveBeenCalled();
  });

  describe('when another target already mirrors the same source', () => {
    const elsewhere = {
      id: 'account-2',
      workspaceId: 'workspace-2',
      repositories: [repository('repo-9', ['team-z'])],
    };

    it('refuses to turn the mirror on, in any workspace', async () => {
      admin.mockResolvedValue('workspace-1');
      const second = setUp([repository('repo-1')], [elsewhere]);

      await expect(
        second.setGitIssues('workspace-1', 'user-1', 'repo-1', ['team-a']),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(write).not.toHaveBeenCalled();
    });

    it('lets the first target change its teams and turn off', async () => {
      admin.mockResolvedValue('workspace-2');
      const first = setUp(
        [repository('repo-9', ['team-z'])],
        [
          elsewhere,
          {
            id: 'account-1',
            workspaceId: 'workspace-1',
            repositories: [repository('repo-1', ['team-a'])],
          },
        ],
      );

      await first.setGitIssues('workspace-2', 'user-1', 'repo-9', ['team-y']);
      await first.setGitIssues('workspace-2', 'user-1', 'repo-9', []);

      expect(write).toHaveBeenCalledTimes(2);
    });
  });
});
