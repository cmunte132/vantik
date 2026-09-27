import axios from 'axios';
import {
  cleanRepoPath,
  COMMIT_SHA,
  MAX_REPO_FILE_BYTES,
  REPO_READ_TIMEOUT_MS,
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

function headers(token: string) {
  return { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` };
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
 *
 * The JSON form of the contents API rather than the raw one, because only it
 * says what the path is: a folder comes back as a listing, which the raw form
 * would hand over as if it were the file's text.
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
        headers: headers(token),
        timeout: REPO_READ_TIMEOUT_MS,
        // Base64 and the JSON around it, for a file at the size limit.
        maxContentLength: MAX_REPO_FILE_BYTES * 2,
      },
    );

    return fileOf(data);
  } catch (error) {
    if (statusOf(error) === 404) {
      return (await repositoryAnswers(fullName, token))
        ? { missing: true }
        : { unknown: true, reason: `GitHub did not show ${fullName}` };
    }

    return { unknown: true, reason: reasonFor(error) };
  }
}

/**
 * The text of a contents API answer, when the path is a file.
 *
 * A folder is answered with a listing, and a symlink or submodule with an
 * object of its own type: the repository answered, and there is no file there
 * whose lines could be cited. A file too large for the API to inline, or an
 * answer of any other shape, says nothing about the code.
 */
function fileOf(data: unknown): RepoFileRead {
  if (Array.isArray(data)) {
    return { missing: true };
  }

  const entry = data as Partial<{
    type: unknown;
    encoding: unknown;
    content: unknown;
    size: unknown;
  }> | null;

  if (typeof entry?.type === 'string' && entry.type !== 'file') {
    return { missing: true };
  }

  if (typeof entry?.size === 'number' && entry.size > MAX_REPO_FILE_BYTES) {
    return { unknown: true, reason: 'the file is too large to check' };
  }

  if (
    entry?.type === 'file' &&
    entry.encoding === 'base64' &&
    typeof entry.content === 'string'
  ) {
    return { content: Buffer.from(entry.content, 'base64').toString('utf8') };
  }

  return {
    unknown: true,
    reason: 'GitHub answered with something other than a file',
  };
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
      timeout: REPO_READ_TIMEOUT_MS,
    });
    const branch = repository?.default_branch;

    if (!branch) {
      return { unknown: true, reason: `${fullName} has no default branch` };
    }

    const { data } = await axios.get(
      `${API}/repos/${fullName}/branches/${encodeURIComponent(branch)}`,
      { headers: headers(token), timeout: REPO_READ_TIMEOUT_MS },
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
    await axios.get(`${API}/repos/${fullName}`, {
      headers: headers(token),
      timeout: REPO_READ_TIMEOUT_MS,
    });
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
