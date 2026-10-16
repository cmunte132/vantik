import { LocalRepositoryTargets } from './local-repository-targets';

describe('LocalRepositoryTargets', () => {
  const entry = (id: string, gitIssues?: { teamIds: string[] }) => ({
    id,
    fullName: id,
    path: `/home/${id}`,
    addedAt: '2026-10-01T00:00:00Z',
    ...(gitIssues ? { gitIssues } : {}),
  });

  function targets(settings: unknown[]) {
    const findMany = jest.fn().mockResolvedValue(
      settings.map((value, index) => ({
        id: `account-${index}`,
        workspaceId: `workspace-${index}`,
        settings: value,
      })),
    );

    return {
      list: () =>
        new LocalRepositoryTargets({
          integrationAccount: { findMany },
        } as never).list(),
      findMany,
    };
  }

  it('lists only the repositories that an admin opted in, with their teams', async () => {
    const { list, findMany } = targets([
      {
        repositories: [
          entry('off'),
          entry('empty', { teamIds: [] }),
          entry('on', { teamIds: ['team-a', 'team-b'] }),
        ],
      },
      // The settings column can hold a JSON string.
      JSON.stringify({
        repositories: [entry('other', { teamIds: ['team-c'] })],
      }),
      null,
    ]);

    expect(await list()).toEqual([
      {
        workspaceId: 'workspace-0',
        integrationAccountId: 'account-0',
        externalRepoId: 'on',
        label: '/home/on',
        teamIds: ['team-a', 'team-b'],
      },
      {
        workspaceId: 'workspace-1',
        integrationAccountId: 'account-1',
        externalRepoId: 'other',
        label: '/home/other',
        teamIds: ['team-c'],
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deleted: null,
          integrationDefinition: { slug: 'local-repo' },
        }),
      }),
    );
  });
});
