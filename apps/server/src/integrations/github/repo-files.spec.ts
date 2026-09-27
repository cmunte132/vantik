/**
 * Reading a GitHub repository's files for citations.
 *
 * Through a stubbed axios, because a real call needs a GitHub App and a
 * repository. What matters is which answer each response becomes: only a
 * repository that answered can say a file is missing.
 */
import { IntegrationPayloadEventType } from '@vantikhq/types';
import axios from 'axios';
import { REPO_READ_TIMEOUT_MS } from 'integrations/repo-files';
import { type PluginContext } from 'plugins/plugin.interface';

import { githubHead, readGithubFile } from './repo-files';

import run from './index';

jest.mock('axios');
const mockGetToken = jest.fn(async () => ({
  token: 'person',
  botToken: 'installation',
}));

jest.mock('./get-token', () => ({
  getToken: (...args: unknown[]) => mockGetToken(...(args as [])),
  getBotToken: jest.fn(async () => 'installation'),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';

function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status ${status}`), {
    response: { status },
  });
}

beforeEach(() => mockedAxios.get.mockReset());

describe('readGithubFile', () => {
  function file(text: string, overrides: Record<string, unknown> = {}) {
    return {
      data: {
        type: 'file',
        encoding: 'base64',
        size: Buffer.byteLength(text),
        content: Buffer.from(text)
          .toString('base64')
          .replace(/(.{60})/g, '$1\n'),
        ...overrides,
      },
    };
  }

  it('[KG-2.3] reads the file at the commit through the contents API, with the installation token', async () => {
    const text = '{"not": "parsed"}\n'.repeat(10);
    mockedAxios.get.mockResolvedValueOnce(file(text));

    await expect(
      readGithubFile('acme/api', 'src/a b.ts', SHA, 'installation'),
    ).resolves.toEqual({ content: text });

    const [url, config] = mockedAxios.get.mock.calls[0];
    expect(url).toBe(
      `https://api.github.com/repos/acme/api/contents/src/a%20b.ts?ref=${SHA}`,
    );
    expect(config).toMatchObject({
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer installation',
      },
      timeout: REPO_READ_TIMEOUT_MS,
    });
  });

  it('[KG-2.3] answers missing for a folder, a symlink or a submodule: there is no file to cite', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [{ type: 'file', name: 'a.ts' }],
    });
    await expect(
      readGithubFile('acme/api', 'src', SHA, 'installation'),
    ).resolves.toEqual({ missing: true });

    for (const type of ['symlink', 'submodule', 'dir']) {
      mockedAxios.get.mockResolvedValueOnce({ data: { type } });
      await expect(
        readGithubFile('acme/api', 'src/link', SHA, 'installation'),
      ).resolves.toEqual({ missing: true });
    }
  });

  it('[KG-2.3] answers unknown for a file too large to check, or an answer that is not a file', async () => {
    mockedAxios.get.mockResolvedValueOnce(
      file('', { size: 5_000_000, encoding: 'none', content: '' }),
    );
    await expect(
      readGithubFile('acme/api', 'big.json', SHA, 'installation'),
    ).resolves.toEqual({
      unknown: true,
      reason: 'the file is too large to check',
    });

    mockedAxios.get.mockResolvedValueOnce({ data: '<html>proxy</html>' });
    await expect(
      readGithubFile('acme/api', 'a.ts', SHA, 'installation'),
    ).resolves.toMatchObject({ unknown: true });
  });

  it('[KG-2.3] calls a 404 missing only once the repository itself has answered', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValueOnce({ data: { full_name: 'acme/api' } });

    await expect(
      readGithubFile('acme/api', 'gone.ts', SHA, 'installation'),
    ).resolves.toEqual({ missing: true });
  });

  it('[KG-2.3] answers unknown when the 404 is the token not seeing the repository', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(404));

    await expect(
      readGithubFile('acme/api', 'a.ts', SHA, 'installation'),
    ).resolves.toMatchObject({ unknown: true });
  });

  it('[KG-2.3] answers unknown for rate limits, outages and a missing token', async () => {
    mockedAxios.get.mockRejectedValueOnce(httpError(403));
    await expect(
      readGithubFile('acme/api', 'a.ts', SHA, 'installation'),
    ).resolves.toEqual({ unknown: true, reason: 'GitHub answered 403' });

    mockedAxios.get.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      readGithubFile('acme/api', 'a.ts', SHA, 'installation'),
    ).resolves.toMatchObject({ unknown: true });

    await expect(
      readGithubFile('acme/api', 'a.ts', SHA, undefined),
    ).resolves.toMatchObject({ unknown: true });
  });

  it('[KG-2.3] never builds a URL from a path, ref or repository that could leave the repository', async () => {
    for (const [fullName, path, ref] of [
      ['acme/api', '../../orgs/acme', SHA],
      ['acme/api', 'a.ts', 'main?x=1'],
      ['acme/api/../../x', 'a.ts', SHA],
      ['../api', 'a.ts', SHA],
      ['acme/..', 'a.ts', SHA],
      ['acme/api', '.', SHA],
      ['acme/api', 'src/.', SHA],
    ]) {
      await expect(
        readGithubFile(fullName, path, ref, 'installation'),
      ).resolves.toMatchObject({ unknown: true });
    }

    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

describe('githubHead', () => {
  it('[KG-2.3] resolves the commit at the head of the default branch', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { default_branch: 'trunk' } })
      .mockResolvedValueOnce({ data: { commit: { sha: SHA } } });

    await expect(githubHead('acme/api', 'installation')).resolves.toEqual({
      sha: SHA,
    });
    expect(mockedAxios.get.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/acme/api/branches/trunk',
    );
    for (const [, config] of mockedAxios.get.mock.calls) {
      expect(config).toMatchObject({ timeout: REPO_READ_TIMEOUT_MS });
    }
  });

  it('[KG-2.3] answers unknown when GitHub cannot be asked', async () => {
    mockedAxios.get.mockRejectedValueOnce(httpError(502));

    await expect(githubHead('acme/api', 'installation')).resolves.toEqual({
      unknown: true,
      reason: 'GitHub answered 502',
    });
  });
});

describe('the plugin entry point', () => {
  const ctx = {} as PluginContext;

  it('[KG-2.3] reads a file for a citation with the bot token alone', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('content\n').toString('base64'),
      },
    });

    await expect(
      run(
        {
          event: IntegrationPayloadEventType.READ_REPO_FILE,
          integrationAccountId: 'account-1',
          data: { fullName: 'acme/api', path: 'a.ts', ref: SHA },
        },
        ctx,
      ),
    ).resolves.toEqual({ content: 'content\n' });
    expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer installation' },
    });
    // The person's token is not asked for, so it is not refreshed.
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('[KG-2.3] resolves a repository head with the bot token', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { commit: { sha: SHA } } });

    await expect(
      run(
        {
          event: IntegrationPayloadEventType.RESOLVE_REPO_HEAD,
          integrationAccountId: 'account-1',
          data: { fullName: 'acme/api' },
        },
        ctx,
      ),
    ).resolves.toEqual({ sha: SHA });
  });
});
