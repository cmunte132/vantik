import { CodeChangeEvent } from '@vantikhq/types';
import axios from 'axios';

import { getGithubHeaders } from './utils';

/**
 * How a GitHub pull request becomes a `CodeChangeEvent`.
 *
 * The server routes a change to modules by the paths that it touches. GitHub
 * does not put those paths in the webhook, so this file reads the webhook for
 * the repository and the issue, and then asks the API for the files.
 */

/** The events that carry a set of changed files worth a look. */
const ROUTED_ACTIONS = [
  'opened',
  'reopened',
  'synchronize',
  'edited',
  'closed',
];

/** GitHub returns at most 100 files on one page, and at most 3000 in total. */
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 30;

/** What the webhook itself says about a pull request. */
export interface PullRequestRef {
  externalRepoId: string;
  /** The full name of the repository, such as `vantikhq/vantik`. */
  fullName: string;
  pullNumber: number;
  issueKeys: string[];
}

/**
 * This function returns every issue key in a piece of text.
 *
 * A key is a team identifier, a dash, and a number, such as `ENG-42`. A person
 * writes it in the title of a pull request, in the body, or in the name of the
 * branch. The function reads all three the same way.
 *
 * The match is wide on purpose. `UTF-8` and `SHA-1` have the shape of a key,
 * and this function returns them. The caller checks each key against the teams
 * of the workspace, and a key that names no team reaches no issue.
 */
export function issueKeysIn(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }

  const keys = new Set<string>();

  // The boundaries are lookarounds and not `\b`, because an underscore is a
  // word character. `\b` therefore finds no key in the branch name
  // `eng_42_sync`, which is a name that a person writes.
  const pattern =
    /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})[-_](\d{1,7})(?![0-9])/g;

  for (const match of text.matchAll(pattern)) {
    keys.add(`${match[1].toUpperCase()}-${Number(match[2])}`);
  }

  return [...keys];
}

/**
 * This function reads a webhook payload and returns what it says about a pull
 * request.
 *
 * It returns null when the payload describes something other than a pull
 * request, and when the payload names no issue. The server then does no work
 * and asks GitHub for nothing.
 */
export function parsePullRequestEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventBody: any,
): PullRequestRef | null {
  const pullRequest = eventBody?.pull_request;
  const repository = eventBody?.repository;

  if (!pullRequest || !repository?.id) {
    return null;
  }

  if (eventBody.action && !ROUTED_ACTIONS.includes(eventBody.action)) {
    return null;
  }

  const issueKeys = [
    ...new Set([
      ...issueKeysIn(pullRequest.title),
      ...issueKeysIn(pullRequest.body),
      ...issueKeysIn(pullRequest.head?.ref),
    ]),
  ];

  if (issueKeys.length === 0) {
    return null;
  }

  return {
    externalRepoId: repository.id.toString(),
    fullName: repository.full_name,
    pullNumber: pullRequest.number,
    issueKeys,
  };
}

/**
 * This function asks GitHub for the paths that a pull request changes.
 *
 * GitHub returns the files one page at a time. The function reads the pages in
 * order, and it stops at an empty page or at the page limit. A pull request
 * with more files than the limit allows is a rare thing, and the modules of the
 * first three thousand files describe it well enough.
 */
export async function changedPathsOf(
  ref: PullRequestRef,
  accessToken: string,
): Promise<string[]> {
  const paths: string[] = [];

  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const url =
      `https://api.github.com/repos/${ref.fullName}/pulls/${ref.pullNumber}` +
      `/files?per_page=${FILES_PER_PAGE}&page=${page}`;

    // A page that fails ends the loop and keeps the pages before it. A rate
    // limit part way through a large pull request is the usual reason, and the
    // modules of the files already read are a better answer than none. Without
    // this the error left the function, which is not what its caller was told
    // to expect.
    const data = await pageOrNull(url, accessToken);

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    for (const file of data) {
      if (file?.filename) {
        paths.push(file.filename);
      }

      // A renamed file leaves one module and joins another. Both modules have
      // a claim on the change, so the old path counts too.
      if (file?.previous_filename) {
        paths.push(file.previous_filename);
      }
    }

    if (data.length < FILES_PER_PAGE) {
      break;
    }
  }

  return paths;
}

/**
 * Reads one page of files, and returns null rather than throwing.
 *
 * eslint-disable is for the shape GitHub returns, which is a list of objects
 * this file reads two fields from and does not otherwise model.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pageOrNull(url: string, accessToken: string): Promise<any> {
  try {
    const { data } = await axios.get(url, getGithubHeaders(accessToken));

    return data;
  } catch {
    return null;
  }
}

/**
 * This function turns a GitHub webhook into a `CodeChangeEvent`.
 *
 * It returns null when the webhook is not a pull request, when the pull request
 * names no issue, and when GitHub refuses the request for the files. A webhook
 * that this function cannot read is not a fault, and it must not stop the rest
 * of the webhook handler.
 */
export async function codeChangeOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventBody: any,
  accessToken: string | undefined,
): Promise<CodeChangeEvent | null> {
  const ref = parsePullRequestEvent(eventBody);

  if (!ref || !accessToken) {
    return null;
  }

  const changedPaths = await changedPathsOf(ref, accessToken);

  if (changedPaths.length === 0) {
    return null;
  }

  return {
    externalRepoId: ref.externalRepoId,
    changedPaths,
    issueKeys: ref.issueKeys,
  };
}
