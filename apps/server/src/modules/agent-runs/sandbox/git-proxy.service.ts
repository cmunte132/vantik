import type { AgentRunDelivery, AgentRunRepoSource } from '@vantikhq/types';

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';

import { git, type GitRemote } from 'modules/git/git-command';
import { deliversPullRequest } from 'modules/git/git-source';
import {
  GitSourcesService,
  type ResolvedRepo,
} from 'modules/git/git-sources.service';
import {
  type Checkout,
  RepoMirrorService,
} from 'modules/git/repo-mirror.service';
import { LoggerService } from 'modules/logger/logger.service';

import { GENERATED_DIRS } from './tree-tools';

const exec = promisify(execFile);

export interface PushRequest {
  workspaceId: string;
  /** The repository the run is against. */
  source: AgentRunRepoSource;
  branch: string;
  /** The branch the run started from, which a pull request merges into. */
  baseBranch: string;
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
  /** `pull_request` when the source opened one, else `branch`. */
  delivery: AgentRunDelivery;
  prUrl?: string;
}

export interface CheckoutRequest {
  workspaceId: string;
  source: AgentRunRepoSource;
  /** Absent for the source's default branch. */
  baseBranch?: string;
}

/**
 * Push and pull-request creation, performed host-side on the guest's request.
 *
 * This is the control that actually defeats prompt injection, and it is worth
 * being precise about why. A sandbox stops an agent from rooting the host. It
 * does nothing about an agent that has been talked into exfiltrating the
 * credential it was handed — because that agent is using the credential
 * exactly as intended, just on someone else's behalf.
 *
 * So the git token never enters the guest. The guest produces a working
 * tree; the host commits it in a directory the guest cannot see, and pushes
 * with a credential the guest never held. The strongest thing an injected agent can
 * do is write a bad patch, which a human reviews.
 *
 * The same pattern every production implementation converged on independently:
 * Codex removes secrets before the agent phase, Claude Code on the web keeps
 * the GitHub token in a proxy outside the sandbox, and Anthropic's managed
 * agents inject the token after the request leaves the sandbox.
 *
 * Both halves go through the server's mirror of the repository and the
 * repository's source, so a directory on this machine, GitHub and any other
 * git host are handled the same way.
 */
@Injectable()
export class GitProxyService {
  private readonly logger = new LoggerService('GitProxyService');

  constructor(
    private gitSources: GitSourcesService,
    private mirrors: RepoMirrorService,
  ) {}

  /**
   * Produces the working tree the guest will run against, host-side.
   *
   * The guest does not clone. It cannot: the git host is deliberately absent
   * from its egress allowlist, and a token that would authenticate against one
   * never enters it. So the host fetches into its mirror, and hands over the
   * *contents* — which is also why `.git` is excluded rather than sent and
   * deleted later. Nothing to strip is stronger than stripping, and agents
   * demonstrably mine bundled history for the commit that fixes the bug
   * instead of deriving a fix.
   */
  async materializeCheckout(request: CheckoutRequest): Promise<Checkout> {
    const resolved = await this.gitSources.require({
      workspaceId: request.workspaceId,
      ...request.source,
    });

    return await this.mirrors.checkout(resolved, request.baseBranch);
  }

  /**
   * Commits a guest-produced working tree and pushes it, host-side.
   *
   * Returns without a commit when the tree is identical to the base, so "the
   * agent changed nothing" is decided by comparing files rather than by
   * trusting the guest to say so.
   *
   * The work clone comes from the mirror, in a directory created after the
   * guest is already gone, and is removed in a `finally` regardless of
   * outcome. The credential for the push lives only in the environment of the
   * git processes that need it.
   */
  async pushWorkTree(request: PushRequest): Promise<PushResult | undefined> {
    const resolved = await this.gitSources.require({
      workspaceId: request.workspaceId,
      ...request.source,
    });

    const scratch = await mkdtemp(join(tmpdir(), 'vantik-push-'));
    const workdir = join(scratch, 'repo');
    let remote: GitRemote | undefined;

    try {
      await this.mirrors.workClone(resolved, request.baseCommit, workdir);

      remote = await resolved.source.pushRemote(resolved.repo);

      const branch = await this.freeBranch(workdir, remote, request.branch);

      await git(['checkout', '--quiet', '-b', branch], { cwd: workdir });

      const archive = join(scratch, 'tree.tar.gz');
      await writeFile(archive, Buffer.from(request.treeBase64, 'base64'));

      await this.replaceWorkTree(workdir, archive);

      await git(['add', '-A'], { cwd: workdir });

      // Nothing staged means the agent finished with the tree it started with.
      // Committing an empty change and pushing a branch for it would be worse
      // than saying so.
      const staged = await git(['diff', '--cached', '--name-only'], {
        cwd: workdir,
      });

      if (!staged.trim()) {
        return undefined;
      }

      await git(
        [
          '-c',
          'user.name=Vantik Agent',
          '-c',
          'user.email=agent@vantik.local',
          'commit',
          '--no-verify',
          '--quiet',
          '-m',
          request.commitMessage,
        ],
        { cwd: workdir },
      );

      const headCommit = (
        await git(['rev-parse', 'HEAD'], { cwd: workdir })
      ).trim();

      await git(['push', '--quiet', remote.url, `HEAD:refs/heads/${branch}`], {
        cwd: workdir,
        remote,
      });

      // A source with no pull requests, such as a directory on this machine,
      // hands back the branch itself.
      if (!deliversPullRequest(resolved.source, resolved.repo)) {
        return { branch, headCommit, delivery: 'branch' };
      }

      const prUrl = await this.openChangeRequest(resolved, {
        ...request,
        branch,
      });

      return { branch, headCommit, delivery: 'pull_request', prUrl };
    } finally {
      await remote?.dispose();
      await rm(scratch, { recursive: true, force: true }).catch(
        (): undefined => undefined,
      );
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
  private async freeBranch(
    workdir: string,
    remote: GitRemote,
    wanted: string,
  ): Promise<string> {
    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? wanted : `${wanted}-${suffix + 1}`;
      const existing = await git(
        ['ls-remote', '--heads', remote.url, `refs/heads/${candidate}`],
        { cwd: workdir, remote },
      );

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
    await git(['rm', '-r', '--quiet', '--ignore-unmatch', '.'], {
      cwd: workdir,
    });

    await exec('tar', ['-xzf', archive, '-C', workdir], {
      maxBuffer: 64 * 1024 * 1024,
    });

    await this.restoreGenerated(workdir);
  }

  /**
   * Puts back what the repository tracks under a generated directory's name.
   *
   * The guest leaves those directories out of the archive, so a tracked file
   * under one of them, say a checked-in `coverage/badge.svg`, is missing from
   * it. The agent did not delete it; it was not sent. Restored from the base,
   * it stays as it was. An edit the agent made to such a file is lost the same
   * way, which is the lesser harm: a pull request that silently deletes files
   * is the one a reviewer merges by mistake.
   */
  private async restoreGenerated(workdir: string): Promise<void> {
    const tracked = await git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
      cwd: workdir,
      maxBuffer: 64 * 1024 * 1024,
    });

    const left = tracked
      .split('\0')
      .filter(
        (path) =>
          path &&
          path.split('/').some((segment) => GENERATED_DIRS.includes(segment)),
      );

    // In batches, so a long list cannot run past the argument limit.
    for (let start = 0; start < left.length; start += 500) {
      await git(
        [
          '--literal-pathspecs',
          'checkout',
          'HEAD',
          '--',
          ...left.slice(start, start + 500),
        ],
        { cwd: workdir },
      );
    }
  }

  private async openChangeRequest(
    resolved: ResolvedRepo,
    request: PushRequest,
  ): Promise<string | undefined> {
    try {
      return await resolved.source.openChangeRequest?.(resolved.repo, {
        branch: request.branch,
        baseBranch: request.baseBranch,
        title: `${request.issueKey}: ${request.issueTitle}`,
        body: request.summary,
      });
    } catch (error) {
      // The branch is already up, so this is annoying rather than
      // destructive. Reported as its own category so the user is told to open
      // it by hand instead of re-running everything.
      this.logger.info({
        message: `Pushed ${request.branch} but could not open a pull request: ${
          error instanceof Error ? error.message : String(error)
        }`,
        where: 'GitProxyService.openChangeRequest',
      });
      return undefined;
    }
  }
}
