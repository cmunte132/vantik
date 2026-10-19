import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { resolveAdminWorkspaceId } from 'common/workspace-access';

import { GitRemoteService } from './git-remote.service';

jest.mock('common/workspace-access', () => ({
  resolveAdminWorkspaceId: jest.fn(),
}));

describe('GitRemoteService.setGitIssues', () => {
  const admin = resolveAdminWorkspaceId as jest.Mock;
  const entry = { id: '7', fullName: 'owner/project', cloneUrl: 'x' };

  function setUp(
    teams: Array<{ id: string; identifier: string; deleted?: Date | null }>,
    repository: Record<string, unknown> = entry,
  ) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      integrationAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'account-1',
          settings: { repositories: [repository] },
        }),
        update,
      },
      team: { findMany: jest.fn().mockResolvedValue(teams) },
    };
    const service = new GitRemoteService(
      prisma as never,
      {} as never,
      {} as never,
    );
    const written = () =>
      (update.mock.calls[0][0].data.settings as { repositories: unknown[] })
        .repositories;

    return { service, update, prisma, written };
  }

  beforeEach(() => {
    admin.mockReset().mockResolvedValue('workspace-1');
  });

  it('stores the teams in the entry of the repository', async () => {
    const { service, written, prisma } = setUp([
      { id: 'team-a', identifier: 'ENG' },
      { id: 'team-b', identifier: 'OPS' },
    ]);

    const updated = await service.setGitIssues(
      'workspace-1',
      'user-1',
      'account-1',
      '7',
      ['team-a', 'team-b', 'team-a'],
    );

    expect(updated.gitIssues).toEqual({ teamIds: ['team-a', 'team-b'] });
    expect(written()).toEqual([
      { ...entry, gitIssues: { teamIds: ['team-a', 'team-b'] } },
    ]);
    // Only teams of the workspace that the admin check named.
    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: 'workspace-1' }),
      }),
    );
  });

  it('turns the mirror off with an empty list', async () => {
    const { service, written } = setUp([], {
      ...entry,
      gitIssues: { teamIds: ['team-a'] },
    });

    await service.setGitIssues('workspace-1', 'user-1', 'account-1', '7', []);

    expect(written()).toEqual([entry]);
  });

  it('refuses a team that the workspace does not have', async () => {
    const { service, update } = setUp([{ id: 'team-a', identifier: 'ENG' }]);

    await expect(
      service.setGitIssues('workspace-1', 'user-1', 'account-1', '7', [
        'team-a',
        'team-x',
      ]),
    ).rejects.toThrow(/no team with the id team-x/);
    expect(update).not.toHaveBeenCalled();
  });

  it('drops a deleted team of the workspace and keeps the rest', async () => {
    const { service, written } = setUp([
      { id: 'team-a', identifier: 'ENG', deleted: null },
      { id: 'team-gone', identifier: 'OLD', deleted: new Date() },
    ]);

    const updated = await service.setGitIssues(
      'workspace-1',
      'user-1',
      'account-1',
      '7',
      ['team-a', 'team-gone'],
    );

    expect(updated.gitIssues).toEqual({ teamIds: ['team-a'] });
    expect(written()).toEqual([
      { ...entry, gitIssues: { teamIds: ['team-a'] } },
    ]);
  });

  it('refuses two teams that share an identifier', async () => {
    const { service, update } = setUp([
      { id: 'team-a', identifier: 'ENG' },
      { id: 'team-b', identifier: 'ENG' },
    ]);

    await expect(
      service.setGitIssues('workspace-1', 'user-1', 'account-1', '7', [
        'team-a',
        'team-b',
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('writes nothing for a member who is not an admin', async () => {
    admin.mockRejectedValue(new ForbiddenException());
    const { service, update } = setUp([{ id: 'team-a', identifier: 'ENG' }]);

    await expect(
      service.setGitIssues('workspace-1', 'user-1', 'account-1', '7', [
        'team-a',
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a repository that the connection does not have', async () => {
    const { service } = setUp([]);

    await expect(
      service.setGitIssues('workspace-1', 'user-1', 'account-1', 'nope', []),
    ).rejects.toThrow(/no such repository/);
  });
});
