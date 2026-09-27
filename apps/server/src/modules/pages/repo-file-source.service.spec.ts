/**
 * One interface for reading a module repository's files, whatever holds the
 * repository: chosen by the integration account the repository came from.
 */
import { IntegrationPayloadEventType } from '@vantikhq/types';
import { REPO_SOURCE_TIMEOUT_MS } from 'integrations/repo-files';
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

    // loadIntegration returns undefined when it catches a plugin failing.
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

  it('[KG-2.3] answers unknown, never throws, when the integration rejects', async () => {
    const { source, loadIntegration } = build({
      'account-1': { workspaceId: WORKSPACE, slug: 'github' },
    });

    // loadIntegration returns the plugin's promise without awaiting it, so an
    // async plugin that fails (a token refresh that cannot reach GitHub)
    // rejects through it.
    loadIntegration.mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND github.com'),
    );

    await expect(source.read(repo(), 'a.ts', SHA)).resolves.toEqual({
      unknown: true,
      reason:
        'the repository could not be read: getaddrinfo ENOTFOUND github.com',
    });
    await expect(source.head(repo())).resolves.toMatchObject({
      unknown: true,
    });
  });

  it('[KG-2.3] answers unknown when the local checkout cannot be looked up', async () => {
    const { source, pathOf } = build({
      'account-1': { workspaceId: WORKSPACE, slug: 'local-repo' },
    });
    pathOf.mockRejectedValue(new Error('connection terminated'));

    await expect(source.read(repo(), 'a.ts', SHA)).resolves.toMatchObject({
      unknown: true,
    });
    await expect(source.head(repo())).resolves.toMatchObject({
      unknown: true,
    });
  });

  it('[KG-2.3] answers unknown when a read does not finish in time, however many calls it is waiting on', async () => {
    jest.useFakeTimers();

    try {
      const { source, loadIntegration } = build({
        'account-1': { workspaceId: WORKSPACE, slug: 'github' },
      });
      // A token request to a GitHub that never answers.
      loadIntegration.mockReturnValue(new Promise(() => undefined));

      const read = source.read(repo(), 'a.ts', SHA);
      const head = source.head(repo());
      await jest.advanceTimersByTimeAsync(REPO_SOURCE_TIMEOUT_MS);

      await expect(read).resolves.toEqual({
        unknown: true,
        reason: 'the repository did not answer within 15 seconds',
      });
      await expect(head).resolves.toMatchObject({ unknown: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('[KG-2.3] passes on that a file was unread for a reason of its own', async () => {
    const { source, loadIntegration } = build({
      'account-1': { workspaceId: WORKSPACE, slug: 'github' },
    });
    loadIntegration.mockResolvedValueOnce({
      unknown: true,
      reason: 'the file is too large to check',
      thisFileOnly: true,
    });

    await expect(source.read(repo(), 'big.json', SHA)).resolves.toEqual({
      unknown: true,
      reason: 'the file is too large to check',
      thisFileOnly: true,
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
