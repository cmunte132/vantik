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
  parsePushEvent,
} from './pull-request';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const MERGE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** A pull request merged into the default branch, naming no issue. */
function mergedBody(overrides: Record<string, unknown> = {}) {
  return {
    action: 'closed',
    repository: {
      id: 123456,
      full_name: 'vantikhq/vantik',
      default_branch: 'main',
    },
    pull_request: {
      number: 8,
      title: 'Tidy the sync log',
      body: 'No issue for this',
      head: { ref: 'chore/tidy' },
      base: { ref: 'main' },
      merged: true,
      merge_commit_sha: MERGE_SHA,
    },
    ...overrides,
  };
}

/** A push to the default branch. */
function pushBody(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'refs/heads/main',
    before: '1111111111111111111111111111111111111111',
    after: MERGE_SHA,
    repository: {
      id: 123456,
      full_name: 'vantikhq/vantik',
      default_branch: 'main',
    },
    pusher: { name: 'someone' },
    commits: [
      {
        added: ['apps/server/src/new.ts'],
        modified: ['apps/server/src/main.ts'],
        removed: [] as string[],
      },
      {
        added: [] as string[],
        modified: ['apps/server/src/main.ts'],
        removed: ['apps/server/src/old.ts'],
      },
    ],
    ...overrides,
  };
}

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

describe('landed changes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('[KG-6.1] reads a pull request merged into the default branch with no issue key as a change with its merge SHA', async () => {
    expect(parsePullRequestEvent(mergedBody())).toEqual({
      externalRepoId: '123456',
      fullName: 'vantikhq/vantik',
      pullNumber: 8,
      issueKeys: [],
      mergeSha: MERGE_SHA,
    });

    mockedAxios.get.mockResolvedValueOnce({
      data: [{ filename: 'apps/server/src/main.ts' }],
    });

    expect(await codeChangeOf(mergedBody(), 'a-token')).toEqual({
      externalRepoId: '123456',
      changedPaths: ['apps/server/src/main.ts'],
      issueKeys: [],
      mergeSha: MERGE_SHA,
    });
  });

  it('[KG-6.1] carries the merge SHA beside the keys of a keyed pull request, which routes as before', () => {
    const body = mergedBody();
    body.pull_request.body = 'Closes ENG-42';

    expect(parsePullRequestEvent(body)).toMatchObject({
      issueKeys: ['ENG-42'],
      mergeSha: MERGE_SHA,
    });
    // Open, it routes exactly as it did, with nothing landed.
    expect(parsePullRequestEvent(pullRequestBody())).not.toHaveProperty(
      'mergeSha',
    );
  });

  it.each([
    ['closed without merging', { merged: false }],
    ['merged into another branch', { base: { ref: 'release/1.2' } }],
    ['merged with no commit id', { merge_commit_sha: null }],
  ])('[KG-6.1] lands nothing for a pull request %s', (_, pullRequest) => {
    const body = mergedBody();
    Object.assign(body.pull_request, pullRequest);

    // It names no issue either, so there is nothing to do at all.
    expect(parsePullRequestEvent(body)).toBeNull();
  });

  it('[KG-6.1] reads a push to the default branch as a change with its new head and every path it touched', async () => {
    expect(parsePushEvent(pushBody())).toEqual({
      externalRepoId: '123456',
      mergeSha: MERGE_SHA,
      changedPaths: [
        'apps/server/src/new.ts',
        'apps/server/src/main.ts',
        'apps/server/src/old.ts',
      ],
    });

    // A push lists its own files, so GitHub is asked for nothing.
    expect(await codeChangeOf(pushBody(), 'a-token')).toEqual({
      externalRepoId: '123456',
      mergeSha: MERGE_SHA,
      changedPaths: [
        'apps/server/src/new.ts',
        'apps/server/src/main.ts',
        'apps/server/src/old.ts',
      ],
      issueKeys: [],
    });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it.each([
    ['to another branch', { ref: 'refs/heads/feature/x' }],
    ['of a tag', { ref: 'refs/tags/v1.0.0' }],
    ['that deleted the branch', { deleted: true, after: '0'.repeat(40) }],
    ['with no files', { commits: [] }],
  ])('[KG-6.1] lands nothing for a push %s', (_, overrides) => {
    expect(parsePushEvent(pushBody(overrides))).toBeNull();
  });

  it('[KG-6.1] reads the head commit of a push that lists no commits', () => {
    const body = pushBody({
      commits: [],
      head_commit: { added: [], modified: ['README.md'], removed: [] },
    });

    expect(parsePushEvent(body)?.changedPaths).toEqual(['README.md']);
  });

  it('[KG-6.1] does not read a pull request or an issue event as a push', () => {
    expect(parsePushEvent(pullRequestBody())).toBeNull();
    expect(parsePushEvent(mergedBody())).toBeNull();
    expect(parsePushEvent({ action: 'created', issue: {} })).toBeNull();
    expect(parsePushEvent(null)).toBeNull();
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
