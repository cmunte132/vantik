import { type GitRemoteKind } from '@vantikhq/types';
import axios, { type AxiosRequestConfig } from 'axios';

import { type ChangeRequestClosed } from '../git-source';

/** How long one call to the API of a host can take. */
const API_TIMEOUT_MS = 15_000;

/** The most repositories that the add picker reads from one host. */
const MAX_LISTED = 500;

/** The settings of one connection that are not secret. */
export interface RemoteHost {
  kind: GitRemoteKind;
  /** The origin and the path of the host, with no slash at the end. */
  baseUrl: string;
  username: string;
}

/** One repository as the API of a host describes it. */
export interface HostRepository {
  id: string;
  fullName: string;
  webUrl?: string;
  defaultBranch?: string;
  private: boolean;
}

/**
 * This function makes a host address the same each time. It accepts only
 * `http` and `https`, because git sends the token to this address.
 *
 * It returns null if the value is not an address that the server can use.
 */
export function normaliseBaseUrl(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  if (url.username || url.password || url.search || url.hash) {
    return null;
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * This function returns true if a clone address is on the connected host.
 *
 * The server sends the token with every fetch and every push. An address on a
 * different origin, or outside the path of the host, would get the token, so
 * the source refuses it.
 */
export function isOnHost(cloneUrl: string, baseUrl: string): boolean {
  let clone: URL;
  let base: URL;

  try {
    clone = new URL(cloneUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }

  if (clone.origin !== base.origin || clone.username || clone.password) {
    return false;
  }

  const prefix = `${base.pathname.replace(/\/+$/, '')}/`;

  return clone.pathname.startsWith(prefix);
}

/** This function returns the clone address of a repository on a known host. */
export function cloneUrlFor(host: RemoteHost, fullName: string): string {
  return `${host.baseUrl}/${fullName}.git`;
}

/** The account that owns a token: on a well-run host, a bot user. */
export interface HostIdentity {
  login: string;
  /** The name that commits pushed with the token carry as their author. */
  name: string;
  /** The address that commits carry, so the host links them to the account. */
  email: string;
}

/**
 * This function checks the token against the API of the host. It returns the
 * account that owns the token. A generic host has no API, so the function
 * returns null for it.
 */
export async function whoAmI(
  host: RemoteHost,
  token: string,
): Promise<HostIdentity | null> {
  if (host.kind === 'generic') {
    return null;
  }

  const { data } = await axios.get(apiUrl(host, '/user'), request(host, token));

  const login = host.kind === 'gitlab' ? data?.username : data?.login;

  if (typeof login !== 'string' || !login) {
    return null;
  }

  const name = host.kind === 'gitlab' ? data?.name : data?.full_name;
  const email = data?.email;

  return {
    login,
    name: typeof name === 'string' && name ? name : login,
    email:
      typeof email === 'string' && email.includes('@')
        ? email
        : `${login}@noreply.${new URL(host.baseUrl).hostname}`,
  };
}

/**
 * This function returns the repositories that the token can read. Without a
 * token, it returns the public repositories.
 */
export async function listHostRepositories(
  host: RemoteHost,
  token: string | null,
): Promise<HostRepository[]> {
  if (host.kind === 'generic') {
    return [];
  }

  const found: HostRepository[] = [];

  for (let page = 1; found.length < MAX_LISTED; page += 1) {
    const batch =
      host.kind === 'gitlab'
        ? await gitlabPage(host, token, page)
        : await giteaPage(host, token, page);

    found.push(...batch);

    if (batch.length < 50) {
      break;
    }
  }

  return found.slice(0, MAX_LISTED);
}

/** This function reads one repository from the API of the host. */
export async function getHostRepository(
  host: RemoteHost,
  token: string | null,
  fullName: string,
): Promise<HostRepository> {
  if (host.kind === 'gitlab') {
    const { data } = await axios.get(
      apiUrl(host, `/projects/${encodeURIComponent(fullName)}`),
      request(host, token),
    );

    return fromGitlab(data);
  }

  const { data } = await axios.get(
    apiUrl(host, `/repos/${repoPath(fullName)}`),
    request(host, token),
  );

  return fromGitea(data);
}

export interface PullRequestInput {
  fullName: string;
  /** The id that the host gives the repository. GitLab needs it. */
  repositoryId: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/**
 * This function opens a pull request (a merge request on GitLab) and returns
 * its address. A generic host has no API, so the function returns undefined.
 */
export async function openHostPullRequest(
  host: RemoteHost,
  token: string,
  input: PullRequestInput,
): Promise<string | undefined> {
  if (host.kind === 'generic') {
    return undefined;
  }

  if (host.kind === 'gitlab') {
    const { data } = await axios.post(
      apiUrl(
        host,
        `/projects/${encodeURIComponent(input.repositoryId)}/merge_requests`,
      ),
      {
        source_branch: input.branch,
        target_branch: input.baseBranch,
        title: input.title,
        description: input.body,
      },
      request(host, token),
    );

    return typeof data?.web_url === 'string' ? data.web_url : undefined;
  }

  const { data } = await axios.post(
    apiUrl(host, `/repos/${repoPath(input.fullName)}/pulls`),
    {
      head: input.branch,
      base: input.baseBranch,
      title: input.title,
      body: input.body,
    },
    request(host, token),
  );

  return typeof data?.html_url === 'string' ? data.html_url : undefined;
}

/**
 * This function closes a pull request (a merge request on GitLab), leaving a
 * comment on it first. One that is already closed or merged is left alone.
 */
export async function closeHostPullRequest(
  host: RemoteHost,
  token: string,
  input: {
    fullName: string;
    repositoryId: string;
    number: number;
    comment: string;
  },
): Promise<ChangeRequestClosed> {
  if (host.kind === 'gitlab') {
    const base = apiUrl(
      host,
      `/projects/${encodeURIComponent(input.repositoryId)}/merge_requests/${input.number}`,
    );
    const { data } = await axios.get(base, request(host, token));

    if (data?.state === 'merged') {
      return 'merged';
    }
    if (data?.state !== 'opened') {
      return 'already_closed';
    }

    await axios.post(
      `${base}/notes`,
      { body: input.comment },
      request(host, token),
    );
    await axios.put(base, { state_event: 'close' }, request(host, token));

    return 'closed';
  }

  const repo = repoPath(input.fullName);
  const pull = apiUrl(host, `/repos/${repo}/pulls/${input.number}`);
  const { data } = await axios.get(pull, request(host, token));

  if (data?.merged) {
    return 'merged';
  }
  if (data?.state !== 'open') {
    return 'already_closed';
  }

  await axios.post(
    apiUrl(host, `/repos/${repo}/issues/${input.number}/comments`),
    { body: input.comment },
    request(host, token),
  );
  await axios.patch(pull, { state: 'closed' }, request(host, token));

  return 'closed';
}

/**
 * This function returns a short reason for an error from the API of a host.
 * The reason never holds the token, because axios puts the token in a header
 * and this function reads only the status and the body.
 */
export function hostErrorReason(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const message =
      error.response?.data?.message ?? error.response?.data?.error;

    // Never quote the body of a 401 or 403: Forgejo repeats the token it
    // refused there ("access token does not exist [sha: …]").
    if (status === 401) {
      return 'the host does not know the token. It is wrong, revoked or expired';
    }

    if (status === 403) {
      const scopes = missingScopes(error.response?.data);

      return scopes
        ? `the token is missing the scope ${scopes}. Make a token that has it`
        : 'the token has no permission for this. Give it the scopes listed in the connect form';
    }

    if (status === 404) {
      return 'the host has no such repository, or the token cannot read it';
    }

    if (status) {
      return `the host answered ${status}${typeof message === 'string' ? `: ${message}` : ''}`;
    }

    return `the server cannot reach the host (${error.code ?? error.message})`;
  }

  return String((error as Error)?.message ?? error);
}

/**
 * This function reads the scopes that a 403 says the token lacks. Forgejo and
 * Gitea put them in brackets ("required scope(s): [read:user]" or
 * "required=[read:user]"); GitLab puts them in `scope` next to
 * `insufficient_scope`. It returns only text that looks like scope names, so
 * nothing else from the body reaches the person.
 */
function missingScopes(data: unknown): string | null {
  const body = (data ?? {}) as Record<string, unknown>;
  const candidate =
    body.error === 'insufficient_scope' && typeof body.scope === 'string'
      ? body.scope
      : typeof body.message === 'string' && /scope/i.test(body.message)
        ? /\[([^\]]+)\]/.exec(body.message)?.[1]
        : undefined;

  if (!candidate || !/^[\w:.\- ,]{1,120}$/.test(candidate)) {
    return null;
  }

  const scopes = candidate
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((scope) => `"${scope}"`);

  return scopes.length ? scopes.join(' or ') : null;
}

async function giteaPage(
  host: RemoteHost,
  token: string | null,
  page: number,
): Promise<HostRepository[]> {
  const { data } = await axios.get(apiUrl(host, '/repos/search'), {
    ...request(host, token),
    params: { limit: 50, page },
  });

  return Array.isArray(data?.data) ? data.data.map(fromGitea) : [];
}

async function gitlabPage(
  host: RemoteHost,
  token: string | null,
  page: number,
): Promise<HostRepository[]> {
  const { data } = await axios.get(apiUrl(host, '/projects'), {
    ...request(host, token),
    params: {
      per_page: 50,
      page,
      simple: true,
      ...(token ? { membership: true } : {}),
    },
  });

  return Array.isArray(data) ? data.map(fromGitlab) : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromGitea(data: any): HostRepository {
  return {
    id: String(data.id),
    fullName: String(data.full_name),
    webUrl: typeof data.html_url === 'string' ? data.html_url : undefined,
    defaultBranch: data.default_branch || undefined,
    private: Boolean(data.private),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromGitlab(data: any): HostRepository {
  return {
    id: String(data.id),
    fullName: String(data.path_with_namespace),
    webUrl: typeof data.web_url === 'string' ? data.web_url : undefined,
    defaultBranch: data.default_branch || undefined,
    private: data.visibility ? data.visibility !== 'public' : false,
  };
}

function apiUrl(host: RemoteHost, path: string): string {
  return `${host.baseUrl}${host.kind === 'gitlab' ? '/api/v4' : '/api/v1'}${path}`;
}

/** Each segment is encoded, so a name cannot add a path segment of its own. */
function repoPath(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function request(host: RemoteHost, token: string | null): AxiosRequestConfig {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (token) {
    if (host.kind === 'gitlab') {
      headers['PRIVATE-TOKEN'] = token;
    } else {
      headers.Authorization = `token ${token}`;
    }
  }

  // No redirects: a redirect to a different host would carry the token there.
  return { headers, timeout: API_TIMEOUT_MS, maxRedirects: 0 };
}
