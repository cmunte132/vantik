import axios from 'axios';
import {
  cleanRepoPath,
  COMMIT_SHA,
  MAX_REPO_FILE_BYTES,
  type RepoFileRead,
  type RepoHead,
} from 'integrations/repo-files';

import { GITHUB_HEADERS } from './plugin-spec';

/**
 * Files of a GitHub repository, read for knowledge citations.
 *
 * Through the contents API with the installation's bot token, the same token
 * that reads a private repository's pull requests. Nothing here throws: every
 * failure is an answer, and only a repository that answered can say a file is
 * missing.
 */

const API = 'https://api.github.com';

/** `owner/name`, and nothing that could add or climb a segment of a URL. */
const FULL_NAME = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/;

function headers(token: string, accept = GITHUB_HEADERS.Accept) {
  return {
    ...GITHUB_HEADERS,
    Accept: accept,
    Authorization: `Bearer ${token}`,
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

/**
 * One file at a commit.
 *
 * A 404 is ambiguous on GitHub: it is what a missing file returns, and also
 * what a repository the token cannot see returns. So a 404 is only called
 * missing after the repository itself has answered; otherwise the answer is
 * that the repository could not be reached.
 */
export async function readGithubFile(
  fullName: string,
  path: string,
  ref: string,
  token: string | undefined,
): Promise<RepoFileRead> {
  const clean = cleanRepoPath(path);

  if (!clean || !COMMIT_SHA.test(ref) || !FULL_NAME.test(fullName)) {
    return {
      unknown: true,
      reason: 'not a readable repository, path or commit',
    };
  }

  if (!token) {
    return { unknown: true, reason: 'no GitHub token for this repository' };
  }

  const encoded = clean.split('/').map(encodeURIComponent).join('/');

  try {
    const { data } = await axios.get(
      `${API}/repos/${fullName}/contents/${encoded}?ref=${ref}`,
      {
        headers: headers(token, 'application/vnd.github.raw+json'),
        // The raw body is the file. Parsing it as JSON would turn a JSON file
        // into an object and every other file into an error.
        responseType: 'text',
        transformResponse: (body: unknown) => body,
        maxContentLength: MAX_REPO_FILE_BYTES,
      },
    );

    return typeof data === 'string'
      ? { content: data }
      : {
          unknown: true,
          reason: 'GitHub answered with something other than a file',
        };
  } catch (error) {
    if (statusOf(error) === 404) {
      return (await repositoryAnswers(fullName, token))
        ? { missing: true }
        : { unknown: true, reason: `GitHub did not show ${fullName}` };
    }

    return { unknown: true, reason: reasonFor(error) };
  }
}

/** The commit at the head of the repository's default branch. */
export async function githubHead(
  fullName: string,
  token: string | undefined,
): Promise<RepoHead> {
  if (!FULL_NAME.test(fullName)) {
    return { unknown: true, reason: 'not a readable repository' };
  }

  if (!token) {
    return { unknown: true, reason: 'no GitHub token for this repository' };
  }

  try {
    const { data: repository } = await axios.get(`${API}/repos/${fullName}`, {
      headers: headers(token),
    });
    const branch = repository?.default_branch;

    if (!branch) {
      return { unknown: true, reason: `${fullName} has no default branch` };
    }

    const { data } = await axios.get(
      `${API}/repos/${fullName}/branches/${encodeURIComponent(branch)}`,
      { headers: headers(token) },
    );
    const sha = data?.commit?.sha;

    return typeof sha === 'string' && COMMIT_SHA.test(sha)
      ? { sha }
      : { unknown: true, reason: `GitHub gave no commit for ${branch}` };
  } catch (error) {
    return { unknown: true, reason: reasonFor(error) };
  }
}

async function repositoryAnswers(
  fullName: string,
  token: string,
): Promise<boolean> {
  try {
    await axios.get(`${API}/repos/${fullName}`, { headers: headers(token) });
    return true;
  } catch {
    return false;
  }
}

function reasonFor(error: unknown): string {
  const status = statusOf(error);

  return status
    ? `GitHub answered ${status}`
    : `GitHub could not be reached: ${(error as Error)?.message ?? error}`;
}
