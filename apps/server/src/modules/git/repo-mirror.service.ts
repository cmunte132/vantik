import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Injectable } from '@nestjs/common';
import {
  cleanRepoPath,
  cleanSearchQuery,
  COMMIT_SHA,
  MAX_MATCH_TEXT,
  MAX_REPO_FILE_BYTES,
  MAX_SEARCH_MATCHES,
  REPO_READ_TIMEOUT_MS,
  type RepoFileRead,
  type RepoHead,
  type RepoMatch,
  type RepoSearch,
} from 'integrations/repo-files';

import { git, GitCommandError, type GitRemote } from './git-command';
import { type ResolvedRepo } from './git-sources.service';
import { foldersOf, type RepositoryFolder } from './mirror-folders';

/**
 * How long a fetch stays good enough for a read. A read that names a commit
 * the mirror does not have fetches at once, whatever this says.
 */
const FRESH_MS = 60_000;

/**
 * The shortest gap between two fetches that a missing commit forces. A made-up
 * commit id would otherwise make every read a fetch.
 */
const FORCED_FETCH_GAP_MS = 10_000;

/**
 * Above this a checkout is too big to hand to a sandbox as one base64 string.
 * The archive is held in memory twice (a Buffer and its text), so a large
 * monorepo would exhaust the server. A clear refusal is better than a kill.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * The most output one search reads. A text in more files than this holds is
 * too common to be evidence of anything.
 */
const MAX_SEARCH_OUTPUT = 4 * 1024 * 1024;

/**
 * What git says when the mirror answered and there is no file there: the path
 * is not in that commit, or the path is a folder (`bad file`).
 */
const NOT_THERE =
  /does not exist in|exists on disk, but not in|invalid object name|not a valid object name|bad revision|unknown revision|: bad file$/im;

export interface Mirror {
  /** The bare repository on this server. */
  path: string;
  /** The branch work starts from when nothing names one. Null for an empty repository. */
  defaultBranch: string | null;
}

export interface Checkout {
  /** The tracked tree at `baseCommit`, as a gzipped tar, base64 encoded. */
  archiveBase64: string;
  baseCommit: string;
  baseBranch: string;
}

/**
 * The server's own bare copy of every repository it works with.
 *
 * Every source, whatever its tier, is read the same way: the server fetches
 * from the source into a mirror it owns, and reads, checks out and branches
 * from that. So a local directory and a GitHub repository give the same
 * answers to the same questions, and nothing that reads code needs to know
 * where the code lives. Only fetch and push go to the source.
 *
 * A mirror holds every branch (`refs/heads/*`) and no working tree. Its HEAD
 * names the source's default branch, so "the head of the repository" is the
 * same question for every source.
 *
 * One fetch at a time for each mirror. Two callers that ask together share
 * the one fetch rather than race on the same refs.
 */
@Injectable()
export class RepoMirrorService {
  private readonly inFlight = new Map<string, Promise<Mirror>>();
  private readonly fetchedAt = new Map<string, number>();
  private readonly forcedAt = new Map<string, number>();

  /** The directory that holds every mirror. */
  root(): string {
    return resolve(
      process.env.REPO_MIRROR_ROOT || join(homedir(), '.vantik', 'repos'),
    );
  }

  /**
   * Where one repository's mirror lives.
   *
   * Under the integration account, so removing an account can remove its
   * mirrors, and named by a hash of the source's identifier, which may hold
   * characters (a slash, a path) that are not safe as a file name.
   */
  pathOf(resolved: ResolvedRepo): string {
    const name = createHash('sha256')
      .update(resolved.repo.externalRepoId)
      .digest('hex')
      .slice(0, 40);

    return join(this.root(), resolved.repo.integrationAccountId, `${name}.git`);
  }

  /**
   * The mirror, fetched from the source when the last fetch is older than
   * `maxAgeMs`.
   */
  async sync(resolved: ResolvedRepo, maxAgeMs = FRESH_MS): Promise<Mirror> {
    const path = this.pathOf(resolved);
    const running = this.inFlight.get(path);

    if (running) {
      return await running;
    }

    const last = this.fetchedAt.get(path);

    if (last !== undefined && Date.now() - last < maxAgeMs) {
      return { path, defaultBranch: await defaultBranchOf(path) };
    }

    const work = this.fetch(resolved, path).finally(() => {
      this.inFlight.delete(path);
    });

    this.inFlight.set(path, work);

    return await work;
  }

  /** A file at a commit. Never throws: a failure to read is `unknown`. */
  async readFile(
    resolved: ResolvedRepo,
    path: string,
    ref: string,
  ): Promise<RepoFileRead> {
    const clean = cleanRepoPath(path);

    if (!clean || !COMMIT_SHA.test(ref)) {
      return {
        unknown: true,
        reason: 'not a readable path or commit',
        thisFileOnly: true,
      };
    }

    try {
      let mirror = await this.sync(resolved);

      // A commit newer than the last fetch, or on a branch pushed since, is
      // not a missing file. Fetch once and look again.
      if (!(await hasCommit(mirror.path, ref))) {
        mirror = await this.forceSync(resolved, mirror);
      }

      // `cat-file blob` rather than `show`, which prints a folder's listing
      // as if it were a file.
      const content = await git(['cat-file', 'blob', `${ref}:${clean}`], {
        cwd: mirror.path,
        timeoutMs: REPO_READ_TIMEOUT_MS,
        maxBuffer: MAX_REPO_FILE_BYTES + 1,
      });

      return { content };
    } catch (error) {
      if (error instanceof GitCommandError && NOT_THERE.test(error.stderr)) {
        return { missing: true };
      }

      if (/maxBuffer/i.test(String((error as Error)?.message))) {
        return {
          unknown: true,
          reason: 'the file is too large to check',
          thisFileOnly: true,
        };
      }

      return { unknown: true, reason: reasonOf(error) };
    }
  }

  /** The commit at the head of the default branch. Never throws. */
  async head(resolved: ResolvedRepo): Promise<RepoHead> {
    try {
      const mirror = await this.sync(resolved);

      if (!mirror.defaultBranch) {
        return {
          unknown: true,
          reason: `${resolved.repo.fullName} has no commits`,
        };
      }

      return { sha: await commitOf(mirror.path, mirror.defaultBranch) };
    } catch (error) {
      return { unknown: true, reason: reasonOf(error) };
    }
  }

  /**
   * Where a text is found in the files of a commit. The search uses the text
   * as a fixed string and ignores case. It returns at most
   * `MAX_SEARCH_MATCHES` matches, and at most two from one file, so one file
   * cannot fill the list. Never throws.
   *
   * The query goes to git after `-e` as one argument, so it cannot become an
   * option.
   */
  async search(
    resolved: ResolvedRepo,
    query: string,
    ref: string,
  ): Promise<RepoSearch> {
    const clean = cleanSearchQuery(query);

    if (!clean || !COMMIT_SHA.test(ref)) {
      return { unknown: true, reason: 'not a text or commit to search' };
    }

    let out: string;

    try {
      let mirror = await this.sync(resolved);

      if (!(await hasCommit(mirror.path, ref))) {
        mirror = await this.forceSync(resolved, mirror);
      }

      out = await git(
        [
          'grep',
          '-n',
          '-I',
          '-F',
          '-i',
          '--max-count=2',
          '-e',
          clean,
          ref,
          '--',
        ],
        {
          cwd: mirror.path,
          timeoutMs: REPO_READ_TIMEOUT_MS,
          maxBuffer: MAX_SEARCH_OUTPUT,
        },
      );
    } catch (error) {
      // git grep exits 1, and writes nothing, when it finds nothing.
      if (
        error instanceof GitCommandError &&
        error.code === 1 &&
        !error.stderr
      ) {
        return { matches: [] };
      }

      if (/maxBuffer/i.test(String((error as Error)?.message))) {
        return {
          unknown: true,
          reason: 'the text is in too many files; search for a longer text',
        };
      }

      return { unknown: true, reason: reasonOf(error) };
    }

    const matches: RepoMatch[] = [];
    const prefix = `${ref}:`;

    for (const line of out.split('\n')) {
      if (matches.length >= MAX_SEARCH_MATCHES) {
        break;
      }

      // `<ref>:<path>:<line>:<text>`
      const rest = line.startsWith(prefix) ? line.slice(prefix.length) : null;
      const found = rest ? /^(.+?):(\d+):(.*)$/.exec(rest) : null;

      if (found) {
        matches.push({
          path: found[1],
          line: Number(found[2]),
          text: found[3].trim().slice(0, MAX_MATCH_TEXT),
        });
      }
    }

    return { matches };
  }

  /** The folders at the head of the default branch that a module can claim. */
  async folders(resolved: ResolvedRepo): Promise<RepositoryFolder[]> {
    const mirror = await this.sync(resolved);

    return mirror.defaultBranch
      ? await foldersOf(mirror.path, `refs/heads/${mirror.defaultBranch}`)
      : [];
  }

  /**
   * The tracked tree of a branch, for a sandbox to start from.
   *
   * Fetched fresh, because a run that starts from a commit a minute old is a
   * run that may redo work somebody just pushed. `git archive` gives exactly
   * the tracked files at that commit, with no `.git`: agents mine history for
   * the commit that fixed the bug instead of deriving a fix.
   */
  async checkout(
    resolved: ResolvedRepo,
    baseBranch?: string,
  ): Promise<Checkout> {
    const mirror = await this.sync(resolved, 0);
    const branch = baseBranch || mirror.defaultBranch;

    if (!branch) {
      throw new Error(
        `${resolved.repo.fullName} has no commits to start from.`,
      );
    }

    const baseCommit = await commitOf(mirror.path, branch).catch(() => {
      throw new Error(`${resolved.repo.fullName} has no branch ${branch}.`);
    });

    const scratch = await mkdtemp(join(tmpdir(), 'vantik-checkout-'));

    try {
      const archive = join(scratch, 'tree.tar.gz');

      await git(['archive', '--format=tar.gz', '-o', archive, baseCommit], {
        cwd: mirror.path,
      });

      const { size } = await stat(archive);

      if (size > MAX_ARCHIVE_BYTES) {
        throw new Error(
          `${resolved.repo.fullName} is ${Math.round(size / 1024 / 1024)}MB packed, ` +
            'which is too large to seed into a hosted sandbox.',
        );
      }

      return {
        archiveBase64: (await readFile(archive)).toString('base64'),
        baseCommit,
        baseBranch: branch,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(
        (): undefined => undefined,
      );
    }
  }

  /**
   * A working clone of the mirror at one commit, in `directory`, for the
   * server to commit into. Local, so it costs hard links and not a download.
   */
  async workClone(
    resolved: ResolvedRepo,
    baseCommit: string,
    directory: string,
  ): Promise<void> {
    const mirror = await this.sync(resolved);

    if (!(await hasCommit(mirror.path, baseCommit))) {
      await this.forceSync(resolved, mirror);
    }

    await git(['clone', '--quiet', '--no-checkout', mirror.path, directory]);
    await git(['checkout', '--quiet', '--detach', baseCommit], {
      cwd: directory,
    });
  }

  /** A fetch now, unless one was forced within `FORCED_FETCH_GAP_MS`. */
  private async forceSync(
    resolved: ResolvedRepo,
    mirror: Mirror,
  ): Promise<Mirror> {
    const last = this.forcedAt.get(mirror.path);

    if (last !== undefined && Date.now() - last < FORCED_FETCH_GAP_MS) {
      return mirror;
    }

    this.forcedAt.set(mirror.path, Date.now());

    return await this.sync(resolved, 0);
  }

  /** Fetches every branch from the source and points HEAD at its default. */
  private async fetch(resolved: ResolvedRepo, path: string): Promise<Mirror> {
    await ensureBare(path);

    const remote = await resolved.source.fetchRemote(resolved.repo);

    try {
      await git(
        [
          'fetch',
          '--quiet',
          '--prune',
          '--no-tags',
          remote.url,
          '+refs/heads/*:refs/heads/*',
        ],
        { cwd: path, remote },
      );

      const defaultBranch = await this.chooseDefault(resolved, path, remote);

      if (defaultBranch) {
        await git(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], {
          cwd: path,
        });
      }

      this.fetchedAt.set(path, Date.now());

      return { path, defaultBranch };
    } finally {
      await remote.dispose();
    }
  }

  /**
   * The source's own answer when it has one, then the HEAD the remote
   * advertises, then `main` or `master`, then any branch.
   */
  private async chooseDefault(
    resolved: ResolvedRepo,
    path: string,
    remote: GitRemote,
  ): Promise<string | null> {
    const branches = await branchesOf(path);

    if (branches.length === 0) {
      return null;
    }

    const preferred = await resolved.source.defaultBranch?.(resolved.repo);

    if (preferred && branches.includes(preferred)) {
      return preferred;
    }

    const advertised = await git(
      ['ls-remote', '--symref', remote.url, 'HEAD'],
      {
        cwd: path,
        remote,
      },
    )
      .then((out) => /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1] ?? null)
      .catch((): null => null);

    if (advertised && branches.includes(advertised)) {
      return advertised;
    }

    return (
      ['main', 'master'].find((name) => branches.includes(name)) ?? branches[0]
    );
  }
}

async function ensureBare(path: string): Promise<void> {
  const existing = await stat(join(path, 'HEAD')).catch((): null => null);

  if (existing) {
    return;
  }

  await mkdir(path, { recursive: true });
  await git(['init', '--bare', '--quiet', path]);
}

async function branchesOf(path: string): Promise<string[]> {
  const out = await git(
    ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'],
    { cwd: path },
  );

  return out.split('\n').filter(Boolean);
}

async function defaultBranchOf(path: string): Promise<string | null> {
  try {
    const name = (
      await git(['symbolic-ref', '--short', 'HEAD'], { cwd: path })
    ).trim();

    return (await branchesOf(path)).includes(name) ? name : null;
  } catch {
    return null;
  }
}

async function commitOf(path: string, branch: string): Promise<string> {
  const sha = (
    await git(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
      {
        cwd: path,
      },
    )
  ).trim();

  if (!COMMIT_SHA.test(sha)) {
    throw new Error(`No commit at ${branch}.`);
  }

  return sha;
}

async function hasCommit(path: string, ref: string): Promise<boolean> {
  try {
    await git(['cat-file', '-e', `${ref}^{commit}`], { cwd: path });
    return true;
  } catch {
    return false;
  }
}

function reasonOf(error: unknown): string {
  const failure = error as {
    code?: string | number;
    killed?: boolean;
    message?: string;
  };

  if (failure?.killed) {
    return 'git took too long to answer';
  }

  return `the repository could not be read: ${failure?.message ?? String(error)}`;
}
