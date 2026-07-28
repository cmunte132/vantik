/**
 * How a GitHub webhook becomes a change to code.
 *
 * The parsing runs before anything reaches the database, so a mistake here
 * either tags the wrong issue or tags none at all. The network part
 * (`changedPathsOf`) is covered through a stubbed axios, because a real call
 * needs a GitHub App and a repository.
 */
import axios from 'axios';

import {
  changedPathsOf,
  codeChangeOf,
  issueKeysIn,
  parsePullRequestEvent,
} from './pull-request';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function pullRequestBody(overrides: Record<string, unknown> = {}) {
  return {
    action: 'synchronize',
    repository: { id: 123456, full_name: 'vantikhq/vantik' },
    pull_request: {
      number: 7,
      title: 'Fix the sync log',
      body: 'Closes ENG-42',
      head: { ref: 'feat/sync-log' },
    },
    ...overrides,
  };
}

describe('issueKeysIn', () => {
  it('reads a key from a sentence', () => {
    expect(issueKeysIn('Closes ENG-42')).toEqual(['ENG-42']);
  });

  it('reads a key from a branch name', () => {
    expect(issueKeysIn('feat/eng-42-sync-log')).toEqual(['ENG-42']);
  });

  it('reads every key that the text holds', () => {
    expect(issueKeysIn('Closes ENG-42 and ENG-43')).toEqual([
      'ENG-42',
      'ENG-43',
    ]);
  });

  it('holds one entry for a key that appears twice', () => {
    expect(issueKeysIn('ENG-42 fixes ENG-42')).toEqual(['ENG-42']);
  });

  it('makes the identifier upper case', () => {
    expect(issueKeysIn('closes eng-42')).toEqual(['ENG-42']);
  });

  it('removes a leading zero from the number', () => {
    expect(issueKeysIn('ENG-007')).toEqual(['ENG-7']);
  });

  it('reads an underscore the way it reads a dash', () => {
    expect(issueKeysIn('eng_42_sync_log')).toEqual(['ENG-42']);
  });

  it('returns nothing for text with no key', () => {
    expect(issueKeysIn('A pull request that names no issue')).toEqual([]);
    expect(issueKeysIn('')).toEqual([]);
    expect(issueKeysIn(null)).toEqual([]);
  });

  /**
   * The match is wide, so a word of this shape becomes a candidate key. The
   * server checks each key against the teams of the workspace, and a workspace
   * with no team called UTF reaches no issue from this.
   */
  it('returns a word that has the shape of a key', () => {
    expect(issueKeysIn('encoded as UTF-8')).toEqual(['UTF-8']);
  });
});

describe('parsePullRequestEvent', () => {
  it('reads the repository, the number and the keys', () => {
    expect(parsePullRequestEvent(pullRequestBody())).toEqual({
      externalRepoId: '123456',
      fullName: 'vantikhq/vantik',
      pullNumber: 7,
      issueKeys: ['ENG-42'],
    });
  });

  it('reads a key from the branch when the body has none', () => {
    const body = pullRequestBody({
      pull_request: {
        number: 7,
        title: 'Fix the sync log',
        body: null,
        head: { ref: 'feat/eng-99-sync' },
      },
    });

    expect(parsePullRequestEvent(body)?.issueKeys).toEqual(['ENG-99']);
  });

  it('gathers the keys of the title, the body and the branch', () => {
    const body = pullRequestBody({
      pull_request: {
        number: 7,
        title: 'ENG-1 fix',
        body: 'Closes ENG-2',
        head: { ref: 'feat/eng-3-sync' },
      },
    });

    expect(parsePullRequestEvent(body)?.issueKeys).toEqual([
      'ENG-1',
      'ENG-2',
      'ENG-3',
    ]);
  });

  it('returns null for a webhook that is not a pull request', () => {
    expect(parsePullRequestEvent({ action: 'created', issue: {} })).toBeNull();
    expect(parsePullRequestEvent({})).toBeNull();
    expect(parsePullRequestEvent(null)).toBeNull();
  });

  it('returns null for a pull request that names no issue', () => {
    const body = pullRequestBody({
      pull_request: {
        number: 7,
        title: 'A tidy up',
        body: 'No issue for this',
        head: { ref: 'chore/tidy' },
      },
    });

    expect(parsePullRequestEvent(body)).toBeNull();
  });

  it('returns null for an action that carries no new files', () => {
    expect(
      parsePullRequestEvent(pullRequestBody({ action: 'labeled' })),
    ).toBeNull();
  });

  it('returns null when the repository has no identifier', () => {
    expect(
      parsePullRequestEvent(
        pullRequestBody({ repository: { full_name: 'vantikhq/vantik' } }),
      ),
    ).toBeNull();
  });
});

describe('changedPathsOf', () => {
  const ref = {
    externalRepoId: '123456',
    fullName: 'vantikhq/vantik',
    pullNumber: 7,
    issueKeys: ['ENG-42'],
  };

  beforeEach(() => jest.clearAllMocks());

  it('returns the file names of one page', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { filename: 'apps/server/src/main.ts' },
        { filename: 'apps/webapp/src/page.tsx' },
      ],
    });

    expect(await changedPathsOf(ref, 'a-token')).toEqual([
      'apps/server/src/main.ts',
      'apps/webapp/src/page.tsx',
    ]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  /** A renamed file leaves one module and joins another, so both paths count. */
  it('returns the old path of a renamed file', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        {
          filename: 'apps/webapp/src/page.tsx',
          previous_filename: 'apps/server/src/page.tsx',
        },
      ],
    });

    expect(await changedPathsOf(ref, 'a-token')).toEqual([
      'apps/webapp/src/page.tsx',
      'apps/server/src/page.tsx',
    ]);
  });

  it('reads a second page when the first one is full', async () => {
    const full = Array.from({ length: 100 }, (_unused, index) => ({
      filename: `file-${index}.ts`,
    }));

    mockedAxios.get
      .mockResolvedValueOnce({ data: full })
      .mockResolvedValueOnce({ data: [{ filename: 'last.ts' }] });

    const paths = await changedPathsOf(ref, 'a-token');

    expect(paths).toHaveLength(101);
    expect(paths[100]).toBe('last.ts');
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('stops at an empty page', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [] });

    expect(await changedPathsOf(ref, 'a-token')).toEqual([]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });
});

describe('codeChangeOf', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the change that the server routes', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [{ filename: 'apps/server/src/main.ts' }],
    });

    expect(await codeChangeOf(pullRequestBody(), 'a-token')).toEqual({
      externalRepoId: '123456',
      changedPaths: ['apps/server/src/main.ts'],
      issueKeys: ['ENG-42'],
    });
  });

  it('asks GitHub for nothing when the webhook is not a pull request', async () => {
    expect(await codeChangeOf({ action: 'created' }, 'a-token')).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns null when there is no token', async () => {
    expect(await codeChangeOf(pullRequestBody(), undefined)).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns null when the pull request changed no file', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [] });

    expect(await codeChangeOf(pullRequestBody(), 'a-token')).toBeNull();
  });
});
