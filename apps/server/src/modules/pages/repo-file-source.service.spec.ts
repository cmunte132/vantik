/**
 * One interface for reading a module repository's files, whatever holds the
 * repository: chosen by the integration account the repository came from.
 */
import { IntegrationPayloadEventType } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LocalRepoService } from 'modules/local-repo/local-repo.service';

import RepoFileSourceService, { CitedRepo } from './repo-file-source.service';

jest.mock('integrations/local-repo/git-files', () => ({
  readLocalFile: jest.fn(async () => ({ content: 'local\n' })),
  localHead: jest.fn(async () => ({ sha: 'aaaaaaa' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gitFiles = require('integrations/local-repo/git-files');

const WORKSPACE = 'ws-1';
const SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function repo(overrides: Partial<CitedRepo> = {}): CitedRepo {
  return {
    id: 'module-repo-1',
    fullName: 'acme/api',
    externalRepoId: '123',
    integrationAccountId: 'account-1',
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function build(
  accounts: Record<string, { workspaceId: string; slug: string }>,
) {
  const findFirst = jest.fn(
    async ({ where }: { where: { id: string; workspaceId: string } }) => {
      const account = accounts[where.id];
      return account && account.workspaceId === where.workspaceId
        ? { integrationDefinition: { slug: account.slug } }
        : null;
    },
  );
  const loadIntegration = jest.fn();
  const pathOf = jest.fn(async () => '/repos/api');
  const source = new RepoFileSourceService(
    { integrationAccount: { findFirst } } as unknown as PrismaService,
    { loadIntegration } as unknown as IntegrationsService,
    { pathOf } as unknown as LocalRepoService,
  );

  return { source, loadIntegration, pathOf, findFirst };
}

describe('RepoFileSourceService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('[KG-2.3] reads a GitHub repository through the GitHub integration', async () => {
    const { source, loadIntegration } = build({
      'account-1': { workspaceId: WORKSPACE, slug: 'github' },
    });
    loadIntegration.mockResolvedValueOnce({ content: 'remote\n' });

    await expect(source.read(repo(), 'src/a.ts', SHA)).resolves.toEqual({
      content: 'remote\n',
    });
    expect(loadIntegration).toHaveBeenCalledWith('github', {
      event: IntegrationPayloadEventType.READ_REPO_FILE,
      integrationAccountId: 'account-1',
      workspaceId: WORKSPACE,
      data: { fullName: 'acme/api', path: 'src/a.ts', ref: SHA },
    });
  });

  it('[KG-2.3] reads a local repository through git, in its configured checkout', async () => {
    const { source, pathOf } = build({
      'account-1': { workspaceId: WORKSPACE, slug: 'local-repo' },
    });

    await expect(source.read(repo(), 'src/a.ts', SHA)).resolves.toEqual({
      content: 'local\n',
    });
    await expect(source.head(repo())).resolves.toEqual({ sha: 'aaaaaaa' });
    expect(pathOf).toHaveBeenCalledWith(WORKSPACE, '123');
    expect(gitFiles.readLocalFile).toHaveBeenCalledWith(
      '/repos/api',
      'src/a.ts',
      SHA,
    );
  });

  it('[KG-2.3] answers unknown, never missing, when the integration fails or answers nonsense', async () => {
    const { source, loadIntegration } = build({
      'account-1': { workspaceId: WORKSPACE, slug: 'github' },
    });

    // loadIntegration swallows a plugin's throw and returns undefined.
    loadIntegration.mockResolvedValueOnce(undefined);
    await expect(source.read(repo(), 'a.ts', SHA)).resolves.toMatchObject({
      unknown: true,
    });

    loadIntegration.mockResolvedValueOnce({ sha: 'not a commit' });
    await expect(source.head(repo())).resolves.toMatchObject({
      unknown: true,
    });

    loadIntegration.mockResolvedValueOnce({ missing: true });
    await expect(source.read(repo(), 'a.ts', SHA)).resolves.toEqual({
      missing: true,
    });
  });

  it("[KG-2.3] reads nothing through another workspace's account, or a repository with no source", async () => {
    const { source, loadIntegration } = build({
      'account-1': { workspaceId: 'someone-else', slug: 'github' },
    });

    await expect(source.read(repo(), 'a.ts', SHA)).resolves.toMatchObject({
      unknown: true,
    });
    await expect(
      source.head(repo({ integrationAccountId: null })),
    ).resolves.toMatchObject({ unknown: true });
    expect(loadIntegration).not.toHaveBeenCalled();
  });
});
