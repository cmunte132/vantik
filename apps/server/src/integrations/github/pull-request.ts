import { CodeChangeEvent } from '@vantikhq/types';
import axios from 'axios';
import { COMMIT_SHA } from 'integrations/repo-files';

import { getGithubHeaders } from './utils';

/**
 * How a GitHub pull request, or a push, becomes a `CodeChangeEvent`.
 *
 * The server routes a change to modules by the paths that it touches, and
 * checks the knowledge that cites those paths once the change has landed.
 * GitHub does not put a pull request's paths in the webhook, so this file
 * reads the webhook for the repository and the issue, and then asks the API
 * for the files. A push lists its files itself.
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
  /** The merge commit, for a merged pull request. Absent otherwise. */
  mergeSha?: string;
  /** For a merged pull request: whether it was merged into the default branch. */
  onDefaultBranch?: boolean;
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
 * request, and when the payload neither names an issue nor lands a merge on
 * the default branch. The server then does no work and asks GitHub for
 * nothing. A merge needs no issue key: the knowledge that cites the files it
 * changed is checked whether or not anyone named an issue.
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

  const merged = mergeOf(eventBody);

  if (issueKeys.length === 0 && !merged) {
    return null;
  }

  return {
    externalRepoId: repository.id.toString(),
    fullName: repository.full_name,
    pullNumber: pullRequest.number,
    issueKeys,
    ...(merged ?? {}),
  };
}

/**
 * The merge commit of a pull request that was just merged, and whether it was
 * merged into the default branch; or null.
 *
 * Knowledge is checked against the code on the default branch, so only a
 * merge there is checked. A pull request merged into another branch (a release
 * branch, or the branch of a stacked pull request) is still reported with its
 * merge commit, marked as not on the default branch: its change reaches the
 * default branch when that branch is itself merged, and is checked then.
 */
function mergeOf(
  eventBody: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): { mergeSha: string; onDefaultBranch: boolean } | null {
  const pullRequest = eventBody?.pull_request;
  const sha = pullRequest?.merge_commit_sha;
  const defaultBranch = eventBody?.repository?.default_branch;

  if (
    eventBody?.action !== 'closed' ||
    pullRequest?.merged !== true ||
    typeof sha !== 'string' ||
    !COMMIT_SHA.test(sha)
  ) {
    return null;
  }

  return {
    mergeSha: sha,
    onDefaultBranch:
      typeof defaultBranch === 'string' &&
      pullRequest.base?.ref === defaultBranch,
  };
}

/** What a push to the default branch says about the change it lands. */
export interface PushRef {
  externalRepoId: string;
  /** The new head of the default branch. */
  mergeSha: string;
  onDefaultBranch: true;
  changedPaths: string[];
}

/** The commit id GitHub gives a branch that a push deleted. */
const DELETED_SHA = /^0+$/;

/**
 * This function reads a push to a repository's default branch, or returns
 * null for anything else.
 *
 * The webhook handler hands every payload here without its event name, so a
 * push is known by its shape: a branch, the commit it now points to, and the
 * commits it added. A push to another branch changes nothing that knowledge
 * is checked against, and a push that deleted the branch lands nothing.
 *
 * The paths come from the payload, which lists what each pushed commit added,
 * changed and removed. A removed file counts: knowledge citing it is what most
 * needs checking.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parsePushEvent(eventBody: any): PushRef | null {
  const repository = eventBody?.repository;
  const after = eventBody?.after;

  if (
    !repository?.id ||
    typeof eventBody?.ref !== 'string' ||
    typeof after !== 'string' ||
    !Array.isArray(eventBody?.commits) ||
    eventBody.pull_request
  ) {
    return null;
  }

  if (
    typeof repository.default_branch !== 'string' ||
    eventBody.ref !== `refs/heads/${repository.default_branch}` ||
    eventBody.deleted === true ||
    DELETED_SHA.test(after) ||
    !COMMIT_SHA.test(after)
  ) {
    return null;
  }

  const paths = new Set<string>();
  const commits = eventBody.commits.length
    ? eventBody.commits
    : [eventBody.head_commit].filter(Boolean);

  for (const commit of commits) {
    for (const list of [commit?.added, commit?.modified, commit?.removed]) {
      for (const path of Array.isArray(list) ? list : []) {
        if (typeof path === 'string' && path) {
          paths.add(path);
        }
      }
    }
  }

  return paths.size
    ? {
        externalRepoId: repository.id.toString(),
        mergeSha: after,
        onDefaultBranch: true,
        changedPaths: [...paths],
      }
    : null;
}

/**
 * This function asks GitHub for the paths that a pull request changes.
 *
 * GitHub returns the files one page at a time. The function reads the pages in
 * order, and it stops at an empty page or at the page limit. A pull request
 * with more files than the limit allows is a rare thing, and the modules of the
 * first three thousand files describe it well enough.
 *
 * For a merged pull request, a page that fails fails the read: the knowledge
 * citing its files is checked against this list, once, and a list cut short
 * would leave the rest unchecked with nothing to check it later. The error
 * fails the webhook's job, which is tried again.
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

    if (data === null && ref.mergeSha) {
      throw new Error(
        `Could not read page ${page} of the files of merged pull request ` +
          `${ref.fullName}#${ref.pullNumber}`,
      );
    }

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
 * It returns null when the webhook is neither a pull request nor a push to the
 * default branch, when the pull request neither names an issue nor was merged
 * into the default branch, and when GitHub refuses the request for the files.
 * A webhook that this function cannot read is not a fault, and it must not
 * stop the rest of the webhook handler.
 *
 * A push names no issue, so it routes no modules to issues; it carries the
 * commit it landed, which is what knowledge is checked against.
 */
export async function codeChangeOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventBody: any,
  accessToken: string | undefined,
): Promise<CodeChangeEvent | null> {
  const push = parsePushEvent(eventBody);

  if (push) {
    return { ...push, issueKeys: [] };
  }

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
    ...(ref.mergeSha
      ? { mergeSha: ref.mergeSha, onDefaultBranch: ref.onDefaultBranch }
      : {}),
  };
}
