import { PrismaService } from 'nestjs-prisma';

import { GitSourcesService } from './git-sources.service';
import { GithubSource } from './sources/github.source';

/**
 * The one place that decides whether a repository reference is real. Every
 * read, checkout and push goes through it, so what it refuses reaches nothing.
 */

const ACCOUNTS: Record<
  string,
  { workspaceId: string; slug: string; settings: unknown; accountId: string }
> = {
  'github-1': {
    workspaceId: 'ws-1',
    slug: 'github',
    accountId: '555',
    settings: { repositories: [{ id: '123', fullName: 'acme/api' }] },
  },
  'local-1': {
    workspaceId: 'ws-1',
    slug: 'local-repo',
    accountId: 'ws-1',
    settings: JSON.stringify({
      repositories: [
        { id: 'repo-1', fullName: 'vantik', path: '/home/dev/vantik' },
      ],
    }),
  },
  'slack-1': {
    workspaceId: 'ws-1',
    slug: 'slack',
    accountId: 'T1',
    settings: { repositories: [{ id: '123', fullName: 'not-git' }] },
  },
};

function build() {
  const findFirst = jest.fn(
    async ({ where }: { where: { id: string; workspaceId: string } }) => {
      const account = ACCOUNTS[where.id];

      return account && account.workspaceId === where.workspaceId
        ? {
            id: where.id,
            accountId: account.accountId,
            settings: account.settings,
            integrationDefinition: { slug: account.slug },
          }
        : null;
    },
  );

  const findMany = jest.fn(
    async ({ where }: { where: { workspaceId: string } }) =>
      Object.entries(ACCOUNTS)
        .filter(([, account]) => account.workspaceId === where.workspaceId)
        .map(([id, account]) => ({
          id,
          settings: account.settings,
          integrationDefinition: { slug: account.slug },
        })),
  );

  const service = new GitSourcesService(
    { integrationAccount: { findFirst, findMany } } as unknown as PrismaService,
    { slug: 'github', notifies: true } as unknown as GithubSource,
  );

  return { service, findFirst, findMany };
}

describe('GitSourcesService', () => {
  it('resolves a repository its workspace’s account lists, to that account’s source', async () => {
    const { service } = build();

    await expect(
      service.resolve({
        workspaceId: 'ws-1',
        integrationAccountId: 'github-1',
        externalRepoId: '123',
      }),
    ).resolves.toMatchObject({
      source: { slug: 'github' },
      repo: {
        integrationAccountId: 'github-1',
        accountId: '555',
        externalRepoId: '123',
        fullName: 'acme/api',
      },
    });
  });

  it('reads settings stored as a string, as the local account keeps them', async () => {
    const { service } = build();

    await expect(
      service.resolve({
        workspaceId: 'ws-1',
        integrationAccountId: 'local-1',
        externalRepoId: 'repo-1',
      }),
    ).resolves.toMatchObject({
      source: { slug: 'local-repo' },
      repo: { listing: { path: '/home/dev/vantik' } },
    });
  });

  it.each([
    [
      'no account at all',
      { integrationAccountId: null, externalRepoId: '123' },
    ],
    [
      'another workspace’s account',
      {
        integrationAccountId: 'github-1',
        externalRepoId: '123',
        workspaceId: 'ws-2',
      },
    ],
    [
      'a repository the account does not list',
      { integrationAccountId: 'github-1', externalRepoId: '3' },
    ],
    [
      'an account that is not a git source',
      { integrationAccountId: 'slack-1', externalRepoId: '123' },
    ],
    [
      'an account that does not exist',
      { integrationAccountId: 'gone', externalRepoId: '123' },
    ],
  ])('resolves nothing for %s', async (_label, ref) => {
    const { service } = build();

    const resolved = await service.resolve({ workspaceId: 'ws-1', ...ref });

    expect(resolved).toEqual({ unresolved: expect.any(String) });
    await expect(
      service.require({ workspaceId: 'ws-1', ...ref }),
    ).rejects.toThrow(/cannot be used/);
  });

  it('offers the repositories of the git sources only, with their ids', async () => {
    const { service, findMany } = build();

    await expect(service.offered('ws-1')).resolves.toEqual([
      {
        integrationAccountId: 'github-1',
        source: 'github',
        externalRepoId: '123',
        fullName: 'acme/api',
      },
      {
        integrationAccountId: 'local-1',
        source: 'local-repo',
        externalRepoId: 'repo-1',
        fullName: 'vantik',
      },
    ]);
    // A personal account's repositories are not the workspace's to link.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws-1', deleted: null, personal: false },
      }),
    );
  });
});
