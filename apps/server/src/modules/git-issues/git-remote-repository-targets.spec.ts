import { GitRemoteRepositoryTargets } from './git-remote-repository-targets';

describe('GitRemoteRepositoryTargets', () => {
  const entry = (id: string, gitIssues?: unknown) => ({
    id,
    fullName: `owner/${id}`,
    cloneUrl: `https://host.example/owner/${id}.git`,
    addedAt: '2026-10-01T00:00:00Z',
    ...(gitIssues ? { gitIssues } : {}),
  });

  it('lists only the repositories that an admin opted in', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'account-0',
        workspaceId: 'workspace-0',
        settings: {
          repositories: [
            entry('off'),
            entry('empty', { teamIds: [] }),
            entry('on', { teamIds: ['team-a', 7, 'team-b'] }),
          ],
        },
      },
      {
        id: 'account-1',
        workspaceId: 'workspace-1',
        settings: JSON.stringify({
          repositories: [entry('other', { teamIds: ['team-c'] })],
        }),
      },
      { id: 'account-2', workspaceId: 'workspace-2', settings: 'not json' },
      { id: 'account-3', workspaceId: 'workspace-3', settings: null },
    ]);

    const listed = await new GitRemoteRepositoryTargets({
      integrationAccount: { findMany },
    } as never).list();

    expect(listed).toEqual([
      {
        workspaceId: 'workspace-0',
        integrationAccountId: 'account-0',
        externalRepoId: 'on',
        label: 'owner/on',
        teamIds: ['team-a', 'team-b'],
      },
      {
        workspaceId: 'workspace-1',
        integrationAccountId: 'account-1',
        externalRepoId: 'other',
        label: 'owner/other',
        teamIds: ['team-c'],
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deleted: null,
          integrationDefinition: { slug: 'git-remote' },
        }),
      }),
    );
  });
});
