import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';

import { LoggerService } from 'modules/logger/logger.service';

import { CredentialsService } from '../credentials/credentials.service';

const exec = promisify(execFile);

export interface PushRequest {
  workspaceId: string;
  /** The repository the run is against. */
  repoUrl: string;
  branch: string;
  /**
   * The working tree the guest finished with, as a gzipped tar, base64 encoded.
   *
   * A tree rather than a patch. The guest has no git — nothing in it needs one
   * once the host clones and pushes — and a patch would have to be produced by
   * a tool the guest would then need installed, against a baseline it would
   * have to be trusted to keep. Comparing trees host-side asks the guest for
   * nothing but its files.
   */
  treeBase64: string;
  baseCommit: string;
  commitMessage: string;
  issueKey: string;
  issueTitle: string;
  summary: string;
}

export interface PushResult {
  branch: string;
  headCommit: string;
  prUrl?: string;
}

export interface CheckoutRequest {
  workspaceId: string;
  repoUrl: string;
  baseBranch: string;
}

export interface CheckoutResult {
  /** The working tree as a gzipped tar, base64 encoded for transport. */
  archiveBase64: string;
  baseCommit: string;
}

/**
 * Above this a repository is too big to hand over as one base64 string.
 *
 * The archive is held in memory twice over — as a Buffer and as text — so a
 * large monorepo would be a straightforward way to exhaust the server. A clear
 * refusal beats an out-of-memory kill that looks like a crash.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Push and pull-request creation, performed host-side on the guest's request.
 *
 * This is the control that actually defeats prompt injection, and it is worth
 * being precise about why. A sandbox stops an agent from rooting the host. It
 * does nothing about an agent that has been talked into exfiltrating the
 * credential it was handed — because that agent is using the credential
 * exactly as intended, just on someone else's behalf.
 *
 * So the git token never enters the guest. The guest produces a patch; the
 * host applies it in a directory the guest cannot see, and pushes with a
 * credential the guest never held. The strongest thing an injected agent can
 * do is write a bad patch, which a human reviews.
 *
 * The same pattern every production implementation converged on independently:
 * Codex removes secrets before the agent phase, Claude Code on the web keeps
 * the GitHub token in a proxy outside the sandbox, and Anthropic's managed
 * agents inject the token after the request leaves the sandbox.
 */
@Injectable()
export class GitProxyService {
  private readonly logger = new LoggerService('GitProxyService');

  constructor(private credentials: CredentialsService) {}

  /**
   * Produces the working tree the guest will run against, host-side.
   *
   * The guest does not clone. It cannot: the git host is deliberately absent
   * from its egress allowlist, and a token that would authenticate against one
   * never enters it. So the host clones with the credential, and hands over
   * the *contents* — which is also why `.git` is excluded rather than sent and
   * deleted later. Nothing to strip is stronger than stripping, and agents
   * demonstrably mine bundled history for the commit that fixes the bug
   * instead of deriving a fix.
   *
   * A public repository still works with no credential configured, which is
   * what makes this usable before a workspace has finished setting itself up.
   */
  async materializeCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const credential = await this.credentials.reveal(
      request.workspaceId,
      'GIT_TOKEN',
    );

    const scratch = await mkdtemp(join(tmpdir(), 'vantik-checkout-'));
    const workdir = join(scratch, 'repo');

    try {
      const remote = credential
        ? withCredential(request.repoUrl, credential.secret)
        : request.repoUrl;

      await this.git(scratch, [
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--branch',
        request.baseBranch,
        remote,
        workdir,
      ]);

      const baseCommit = (
        await this.git(workdir, ['rev-parse', 'HEAD'])
      ).trim();

      const archive = join(scratch, 'repo.tar.gz');

      // `git archive` rather than `tar` over the directory: it emits exactly
      // the tracked tree at that commit, with no `.git` and no stray untracked
      // file that happened to be lying in the clone.
      await this.git(workdir, [
        'archive',
        '--format=tar.gz',
        '-o',
        archive,
        'HEAD',
      ]);

      const bytes = await readFile(archive);

      if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
        throw new Error(
          `This repository is ${Math.round(bytes.byteLength / 1024 / 1024)}MB ` +
            'packed, which is too large to seed into a hosted sandbox. Use ' +
            'the BYO runner for it.',
        );
      }

      return { archiveBase64: bytes.toString('base64'), baseCommit };
    } finally {
      // The decrypted token lives in the remote URL inside this directory.
      await rm(scratch, { recursive: true, force: true }).catch(
        (): undefined => undefined,
      );
    }
  }

  /**
   * Commits a guest-produced working tree and pushes it, host-side.
   *
   * Returns without a commit when the tree is identical to the base, so "the
   * agent changed nothing" is decided by comparing files rather than by
   * trusting the guest to say so.
   *
   * The scratch clone lives in a directory created after the guest is already
   * gone, and is removed in a `finally` regardless of outcome — a decrypted
   * credential must not survive the request that needed it.
   */
  async pushWorkTree(request: PushRequest): Promise<PushResult | undefined> {
    const credential = await this.credentials.reveal(
      request.workspaceId,
      'GIT_TOKEN',
    );

    if (!credential && needsCredential(request.repoUrl)) {
      throw new Error(
        'This workspace has no git token configured, so there is nowhere to push.',
      );
    }

    const scratch = await mkdtemp(join(tmpdir(), 'vantik-push-'));
    const workdir = join(scratch, 'repo');

    try {
      const authed = credential
        ? withCredential(request.repoUrl, credential.secret)
        : request.repoUrl;

      await this.git(scratch, ['clone', '--quiet', authed, workdir]);
      await this.git(workdir, ['checkout', '--quiet', request.baseCommit]);

      const branch = await this.freeBranch(workdir, request.branch);

      await this.git(workdir, ['checkout', '--quiet', '-b', branch]);

      const archive = join(scratch, 'tree.tar.gz');
      await writeFile(archive, Buffer.from(request.treeBase64, 'base64'));

      await this.replaceWorkTree(workdir, archive);

      await this.git(workdir, ['add', '-A']);

      // Nothing staged means the agent finished with the tree it started with.
      // Committing an empty change and pushing a branch for it would be worse
      // than saying so.
      const staged = await this.git(workdir, ['diff', '--cached', '--name-only']);

      if (!staged.trim()) {
        return undefined;
      }

      await this.git(workdir, [
        '-c',
        'user.name=Vantik Agent',
        '-c',
        'user.email=agent@vantik.local',
        'commit',
        '--no-verify',
        '-m',
        request.commitMessage,
      ]);

      const headCommit = (
        await this.git(workdir, ['rev-parse', 'HEAD'])
      ).trim();

      await this.git(workdir, ['push', '--set-upstream', 'origin', branch]);

      // No token means a local or ssh-agent remote: the branch is pushed, and
      // there is no host to open a pull request against.
      const prUrl = credential
        ? await this.openPullRequest(workdir, { ...request, branch }, credential.secret)
        : undefined;

      return { branch, headCommit, prUrl };
    } finally {
      // The decrypted token lives in the remote URL inside this directory.
      await rm(scratch, { recursive: true, force: true }).catch((): undefined => undefined);
    }
  }

  /**
   * A branch name nothing is already using.
   *
   * A second run on the same issue would otherwise push to the branch the
   * first one made, and be rejected as a non-fast-forward — losing the work
   * for a reason that reads like a git error rather than "this issue has been
   * worked twice". Suffixing keeps both, and never overwrites a branch someone
   * may already be reviewing.
   */
  private async freeBranch(workdir: string, wanted: string): Promise<string> {
    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? wanted : `${wanted}-${suffix + 1}`;
      const existing = await this.git(workdir, [
        'ls-remote',
        '--heads',
        'origin',
        candidate,
      ]);

      if (!existing.trim()) {
        return candidate;
      }
    }

    throw new Error(
      `Every branch name from ${wanted} to ${wanted}-50 is taken on the remote.`,
    );
  }

  /**
   * Swaps the clone's working tree for the guest's, keeping `.git`.
   *
   * The archive is attacker-controlled in the threat model that matters — a
   * prompt-injected agent wrote it — so every entry is inspected before
   * anything is extracted. An absolute path or a `..` component would let the
   * archive write outside the checkout, on the host, with the server's
   * privileges; `tar` alone is not a safe boundary against that.
   *
   * Deleting first is what makes a removed file show up as a deletion rather
   * than silently persisting.
   */
  private async replaceWorkTree(
    workdir: string,
    archive: string,
  ): Promise<void> {
    const listing = await exec('tar', ['-tzf', archive], {
      maxBuffer: 64 * 1024 * 1024,
    });

    for (const entry of listing.stdout.split('\n')) {
      const path = entry.trim();

      if (!path) {
        continue;
      }

      if (path.startsWith('/') || path.split('/').includes('..')) {
        throw new Error(
          `The sandbox returned an archive with an unsafe path (${path}); nothing was extracted.`,
        );
      }
    }

    // `git rm` rather than a raw delete: it leaves `.git` alone, which a
    // recursive delete of the directory would not.
    await this.git(workdir, ['rm', '-r', '--quiet', '--ignore-unmatch', '.']);

    await exec('tar', ['-xzf', archive, '-C', workdir], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  private async openPullRequest(
    workdir: string,
    request: PushRequest,
    token: string,
  ): Promise<string | undefined> {
    try {
      const { stdout } = await exec(
        'gh',
        [
          'pr',
          'create',
          '--title',
          `${request.issueKey}: ${request.issueTitle}`,
          '--body',
          request.summary,
          '--head',
          request.branch,
        ],
        {
          cwd: workdir,
          timeout: 60_000,
          env: { ...process.env, GH_TOKEN: token },
        },
      );

      return stdout.trim().split('\n').pop()?.trim();
    } catch (error) {
      // The branch is already up, so this is annoying rather than
      // destructive. Reported as its own category so the user is told to open
      // it by hand instead of re-running everything.
      this.logger.info({
        message: `Pushed ${request.branch} but could not open a pull request: ${
          error instanceof Error ? error.message : String(error)
        }`,
        where: 'GitProxyService.openPullRequest',
      });
      return undefined;
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    });
    return stdout;
  }
}

/**
 * Whether reaching this remote needs a stored token at all.
 *
 * A path or `file://` remote is on the same machine, and an ssh remote takes
 * its credential from an agent rather than from us. Demanding a token for
 * those would make hosted execution unusable for exactly the local and
 * self-hosted setups it should serve first — and would be asking for a
 * credential that then sits in the database doing nothing.
 */
function needsCredential(repoUrl: string): boolean {
  return /^https?:\/\//i.test(repoUrl);
}

/**
 * Puts the credential in the remote URL for the duration of one clone.
 *
 * Ugly but contained: the URL exists only inside a scratch directory that is
 * deleted in a `finally`, on a host the guest cannot reach. The alternative —
 * a credential helper — leaves state in a global config that outlives the
 * request.
 */
function withCredential(repoUrl: string, token: string): string {
  try {
    const url = new URL(repoUrl);
    url.username = 'x-access-token';
    url.password = token;
    return url.toString();
  } catch {
    // An ssh-style remote takes its credential from the agent, not the URL.
    return repoUrl;
  }
}
