import axios from 'axios';

import { type CredentialsService } from 'modules/agent-runs/credentials/credentials.service';

import { deliversPullRequest, type SourceRepo } from '../git-source';
import {
  hostErrorReason,
  isOnHost,
  listHostRepositories,
  normaliseBaseUrl,
  openHostPullRequest,
  whoAmI,
} from './git-remote-hosts';
import { GitRemoteSource } from './git-remote.source';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');

  return {
    __esModule: true,
    default: { ...actual, get: jest.fn(), post: jest.fn() },
  };
});

// The guard resolves host names. These tests use a name that does not exist.
jest.mock('./host-address-guard', () => ({
  ...jest.requireActual('./host-address-guard'),
  assertHostAllowed: jest.fn().mockResolvedValue(undefined),
}));

const BASE = 'https://forgejo.example.com';

function repo(overrides: Partial<SourceRepo> = {}): SourceRepo {
  return {
    workspaceId: 'ws-1',
    integrationAccountId: 'remote-1',
    accountId: BASE,
    externalRepoId: '3',
    fullName: 'cmunte/perk-pilot',
    listing: {
      id: '3',
      fullName: 'cmunte/perk-pilot',
      cloneUrl: `${BASE}/cmunte/perk-pilot.git`,
      webUrl: `${BASE}/cmunte/perk-pilot`,
      defaultBranch: 'main',
    },
    config: { kind: 'forgejo', baseUrl: BASE, username: 'cmunte' },
    ...overrides,
  };
}

function source(token: string | null = 'secret-token-1234') {
  const credentials = {
    revealRemoteToken: jest.fn().mockResolvedValue(token),
  } as unknown as CredentialsService;

  return new GitRemoteSource(credentials);
}

describe('normaliseBaseUrl', () => {
  it('drops the slash at the end, and keeps a path', () => {
    expect(normaliseBaseUrl('https://git.example.com/')).toBe(
      'https://git.example.com',
    );
    expect(normaliseBaseUrl('https://example.com/gitlab/')).toBe(
      'https://example.com/gitlab',
    );
  });

  it('refuses an address that is not http or https', () => {
    expect(normaliseBaseUrl('ssh://git@example.com:2222')).toBeNull();
    expect(normaliseBaseUrl('file:///etc')).toBeNull();
    expect(normaliseBaseUrl('not a url')).toBeNull();
  });

  it('refuses an address that carries a user name, a query or a fragment', () => {
    expect(normaliseBaseUrl('https://me:pw@git.example.com')).toBeNull();
    expect(normaliseBaseUrl('https://git.example.com?x=1')).toBeNull();
  });
});

describe('isOnHost', () => {
  it('accepts a clone address under the host', () => {
    expect(isOnHost(`${BASE}/a/b.git`, BASE)).toBe(true);
  });

  it('refuses a clone address on a different origin', () => {
    expect(isOnHost('https://evil.example.com/a/b.git', BASE)).toBe(false);
    expect(isOnHost('http://forgejo.example.com/a/b.git', BASE)).toBe(false);
    expect(isOnHost('https://forgejo.example.com:8443/a/b.git', BASE)).toBe(
      false,
    );
  });

  it('refuses a clone address outside the path of the host', () => {
    expect(
      isOnHost('https://example.com/other/a.git', 'https://example.com/gitlab'),
    ).toBe(false);
    expect(
      isOnHost(
        'https://example.com/gitlab-x/a.git',
        'https://example.com/gitlab',
      ),
    ).toBe(false);
  });

  it('refuses a clone address with a user name in it', () => {
    expect(isOnHost('https://me@forgejo.example.com/a/b.git', BASE)).toBe(
      false,
    );
  });
});

describe('GitRemoteSource', () => {
  it('fetches with the token in the environment, never in the address', async () => {
    const remote = await source().fetchRemote(repo());

    expect(remote.url).toBe(`${BASE}/cmunte/perk-pilot.git`);
    expect(remote.url).not.toContain('secret-token-1234');
    expect(Object.values(remote.env).join(' ')).toContain(
      'Authorization: Basic',
    );
    expect(remote.secrets).toContain('secret-token-1234');
  });

  it('turns git redirects off, so a redirect cannot carry the token away', async () => {
    const remote = await source().fetchRemote(repo());
    const keys = Object.entries(remote.env)
      .filter(([name]) => name.startsWith('GIT_CONFIG_KEY_'))
      .map(([, value]) => value);
    const index = keys.indexOf('http.followRedirects');

    expect(index).toBeGreaterThanOrEqual(0);
    expect(remote.env[`GIT_CONFIG_VALUE_${index}`]).toBe('false');
  });

  it('fetches a public repository with no token', async () => {
    const remote = await source(null).fetchRemote(repo());

    expect(remote.env).toEqual({});
  });

  it('refuses to push with no token, and says where to add one', async () => {
    await expect(source(null).pushRemote(repo())).rejects.toThrow(
      /has no token/,
    );
  });

  it('refuses a clone address that is not on the connected host', async () => {
    const tampered = repo({
      listing: {
        ...repo().listing,
        cloneUrl: 'https://evil.example.com/x.git',
      },
    });

    await expect(source().fetchRemote(tampered)).rejects.toThrow(
      /no clone address/,
    );
    await expect(source().pushRemote(tampered)).rejects.toThrow(
      /no clone address/,
    );
  });

  it('starts work from the default branch the host gave', async () => {
    await expect(source().defaultBranch(repo())).resolves.toBe('main');
  });

  it('hands back a pull request on Forgejo, and the branch on a generic host', () => {
    const forgejo = repo();
    const generic = repo({
      config: { kind: 'generic', baseUrl: BASE, username: 'git' },
    });

    expect(deliversPullRequest(source(), forgejo)).toBe(true);
    expect(deliversPullRequest(source(), generic)).toBe(false);
  });

  it('shows the web page of the repository as its location', () => {
    expect(source().location(repo())).toBe(`${BASE}/cmunte/perk-pilot`);
  });

  it('commits as the account that owns the token', () => {
    const bot = repo({
      config: {
        kind: 'forgejo',
        baseUrl: BASE,
        username: 'vantik-bot',
        authorName: 'Vantik Bot',
        authorEmail: 'bot@example.com',
      },
    });

    expect(source().commitAuthor(bot)).toEqual({
      name: 'Vantik Bot',
      email: 'bot@example.com',
    });
    expect(source().commitAuthor(repo())).toBeNull();
  });
});

describe('host API', () => {
  const host = { kind: 'forgejo' as const, baseUrl: BASE, username: 'cmunte' };

  afterEach(() => jest.clearAllMocks());

  it('opens a Forgejo pull request with the token in a header and no redirects', async () => {
    (axios.post as jest.Mock).mockResolvedValue({
      data: { html_url: `${BASE}/cmunte/perk-pilot/pulls/7` },
    });

    const url = await openHostPullRequest(host, 'tok', {
      fullName: 'cmunte/perk-pilot',
      repositoryId: '3',
      branch: 'vantik/eng-1',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });

    expect(url).toBe(`${BASE}/cmunte/perk-pilot/pulls/7`);
    const [address, body, config] = (axios.post as jest.Mock).mock.calls[0];
    expect(address).toBe(`${BASE}/api/v1/repos/cmunte/perk-pilot/pulls`);
    expect(body).toEqual({
      head: 'vantik/eng-1',
      base: 'main',
      title: 'T',
      body: 'B',
    });
    expect(config.headers.Authorization).toBe('token tok');
    expect(config.maxRedirects).toBe(0);
  });

  it('opens a GitLab merge request by project id', async () => {
    (axios.post as jest.Mock).mockResolvedValue({
      data: { web_url: 'https://gitlab.example.com/g/p/-/merge_requests/2' },
    });

    await openHostPullRequest(
      { kind: 'gitlab', baseUrl: 'https://gitlab.example.com', username: 'x' },
      'tok',
      {
        fullName: 'g/p',
        repositoryId: '42',
        branch: 'b',
        baseBranch: 'main',
        title: 'T',
        body: 'B',
      },
    );

    const [address, body, config] = (axios.post as jest.Mock).mock.calls[0];
    expect(address).toBe(
      'https://gitlab.example.com/api/v4/projects/42/merge_requests',
    );
    expect(body.source_branch).toBe('b');
    expect(config.headers['PRIVATE-TOKEN']).toBe('tok');
  });

  it('opens nothing on a generic host', async () => {
    await expect(
      openHostPullRequest({ ...host, kind: 'generic' }, 'tok', {
        fullName: 'a/b',
        repositoryId: 'x',
        branch: 'b',
        baseBranch: 'main',
        title: 'T',
        body: 'B',
      }),
    ).resolves.toBeUndefined();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('lists Forgejo repositories page by page', async () => {
    const page = (start: number, count: number) => ({
      data: {
        data: Array.from({ length: count }, (_, i) => ({
          id: start + i,
          full_name: `o/r${start + i}`,
          default_branch: 'main',
          private: false,
        })),
      },
    });
    (axios.get as jest.Mock)
      .mockResolvedValueOnce(page(1, 50))
      .mockResolvedValueOnce(page(51, 3));

    const found = await listHostRepositories(host, null);

    expect(found).toHaveLength(53);
    expect(found[52]).toMatchObject({ id: '53', fullName: 'o/r53' });
    expect(
      (axios.get as jest.Mock).mock.calls[0][1].headers.Authorization,
    ).toBe(undefined);
  });

  it('reads the Forgejo account that owns the token', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        login: 'vantik-bot',
        full_name: 'Vantik Bot',
        email: 'bot@example.com',
      },
    });

    expect(await whoAmI(host, 'secret-token-1234')).toEqual({
      login: 'vantik-bot',
      name: 'Vantik Bot',
      email: 'bot@example.com',
    });
  });

  it('reads a GitLab bot, and gives it a no-reply address when the host hides one', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: { username: 'project_3_bot_ab12', name: '', email: null },
    });

    expect(
      await whoAmI(
        { kind: 'gitlab', baseUrl: 'https://gitlab.example.com', username: '' },
        'glpat-secret',
      ),
    ).toEqual({
      login: 'project_3_bot_ab12',
      name: 'project_3_bot_ab12',
      email: 'project_3_bot_ab12@noreply.gitlab.example.com',
    });
  });
});

describe('hostErrorReason', () => {
  function refusal(status: number, data: unknown) {
    const { AxiosError } = jest.requireActual('axios');

    return new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, {
      status,
      data,
      statusText: '',
      headers: {},
      config: {},
    });
  }

  it('names the scope a Forgejo token lacks', () => {
    expect(
      hostErrorReason(
        refusal(403, {
          message:
            'token does not have at least one of required scope(s): [read:user]',
        }),
      ),
    ).toBe(
      'the token is missing the scope "read:user". Make a token that has it',
    );
  });

  it('names the scopes in the newer Gitea wording', () => {
    expect(
      hostErrorReason(
        refusal(403, {
          message:
            'token does not have at least one of required scope(s), required=[read:user], token scope=write:issue,write:repository',
        }),
      ),
    ).toBe(
      'the token is missing the scope "read:user". Make a token that has it',
    );
  });

  it('names the scopes a GitLab token lacks', () => {
    expect(
      hostErrorReason(
        refusal(403, { error: 'insufficient_scope', scope: 'api read_api' }),
      ),
    ).toBe(
      'the token is missing the scope "api" or "read_api". Make a token that has it',
    );
  });

  it('points at the connect form when a 403 names no scope', () => {
    expect(hostErrorReason(refusal(403, { message: 'Forbidden' }))).toBe(
      'the token has no permission for this. Give it the scopes listed in the connect form',
    );
  });

  it('never repeats the body of a 401, where Forgejo echoes the token', () => {
    const reason = hostErrorReason(
      refusal(401, {
        message: 'access token does not exist [sha: secret-token-1234]',
      }),
    );

    expect(reason).toBe(
      'the host does not know the token. It is wrong, revoked or expired',
    );
    expect(reason).not.toContain('secret-token-1234');
  });

  it('ignores a bracketed value that is not a list of scopes', () => {
    expect(
      hostErrorReason(
        refusal(403, { message: 'scope check failed [sha: abc/def+ghi==]' }),
      ),
    ).toBe(
      'the token has no permission for this. Give it the scopes listed in the connect form',
    );
  });
});
