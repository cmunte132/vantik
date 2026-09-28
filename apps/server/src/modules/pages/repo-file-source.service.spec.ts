/**
 * One interface for reading a module repository's files, whatever holds the
 * repository: resolved through its integration account, read from the
 * server's mirror.
 */
import { REPO_SOURCE_TIMEOUT_MS } from 'integrations/repo-files';

import {
  GitSourcesService,
  type RepoRef,
  type ResolvedRepo,
} from 'modules/git/git-sources.service';
import { RepoMirrorService } from 'modules/git/repo-mirror.service';

import RepoFileSourceService, { CitedRepo } from './repo-file-source.service';

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
  resolveTo: (ref: RepoRef) => ResolvedRepo | { unresolved: string },
) {
  const resolve = jest.fn(async (ref: RepoRef) => resolveTo(ref));
  const readFile = jest.fn();
  const head = jest.fn();
  const source = new RepoFileSourceService(
    { resolve } as unknown as GitSourcesService,
    { readFile, head } as unknown as RepoMirrorService,
  );

  return { source, resolve, readFile, head };
}

const RESOLVED = {
  source: { slug: 'github' },
  repo: { fullName: 'acme/api' },
} as unknown as ResolvedRepo;

describe('RepoFileSourceService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('[KG-2.3] reads every source from the mirror, through its resolved account', async () => {
    const { source, resolve, readFile } = build(() => RESOLVED);
    readFile.mockResolvedValueOnce({ content: 'remote\n' });

    await expect(source.read(repo(), 'src/a.ts', SHA)).resolves.toEqual({
      content: 'remote\n',
    });
    expect(resolve).toHaveBeenCalledWith(repo());
    expect(readFile).toHaveBeenCalledWith(RESOLVED, 'src/a.ts', SHA);
  });

  it('[KG-2.3] gives the head from the mirror', async () => {
    const { source, head } = build(() => RESOLVED);
    head.mockResolvedValueOnce({ sha: 'aaaaaaa' });

    await expect(source.head(repo())).resolves.toEqual({ sha: 'aaaaaaa' });
  });

  it("[KG-2.3] reads nothing through another workspace's account, or a repository with no source", async () => {
    const { source, readFile } = build(() => ({
      unresolved: 'the source of the repository is no longer connected',
    }));

    await expect(source.read(repo(), 'src/a.ts', SHA)).resolves.toMatchObject({
      unknown: true,
    });
    await expect(source.head(repo())).resolves.toMatchObject({ unknown: true });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('[KG-2.3] answers unknown, never throws, when resolving or reading rejects', async () => {
    const { source, readFile } = build(() => RESOLVED);
    readFile.mockRejectedValueOnce(new Error('disk gone'));

    await expect(source.read(repo(), 'src/a.ts', SHA)).resolves.toEqual({
      unknown: true,
      reason: 'the repository could not be read: disk gone',
    });

    const failing = build(() => {
      throw new Error('database down');
    });

    await expect(failing.source.head(repo())).resolves.toMatchObject({
      unknown: true,
    });
  });

  it('[KG-2.3] passes on that a file was unread for a reason of its own', async () => {
    const { source, readFile } = build(() => RESOLVED);
    readFile.mockResolvedValueOnce({
      unknown: true,
      reason: 'the file is too large to check',
      thisFileOnly: true,
    });

    await expect(source.read(repo(), 'big.bin', SHA)).resolves.toEqual({
      unknown: true,
      reason: 'the file is too large to check',
      thisFileOnly: true,
    });
  });

  it('[KG-2.3] answers unknown when a read does not finish in time', async () => {
    jest.useFakeTimers();

    try {
      const { source, readFile } = build(() => RESOLVED);
      readFile.mockReturnValueOnce(new Promise(() => undefined));

      const answer = source.read(repo(), 'src/a.ts', SHA);
      await jest.advanceTimersByTimeAsync(REPO_SOURCE_TIMEOUT_MS);

      await expect(answer).resolves.toMatchObject({ unknown: true });
    } finally {
      jest.useRealTimers();
    }
  });
});
