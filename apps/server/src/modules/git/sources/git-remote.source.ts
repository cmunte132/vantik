import { Injectable } from '@nestjs/common';
import { GIT_REMOTE_KINDS, type GitRemoteKind } from '@vantikhq/types';

import { CredentialsService } from 'modules/agent-runs/credentials/credentials.service';

import { anonymousRemote, tokenRemote, type GitRemote } from '../git-command';
import {
  type ChangeRequest,
  type ChangeRequestClosed,
  changeRequestNumber,
  type CommitIdentity,
  type GitSource,
  type SourceRepo,
} from '../git-source';
import {
  closeHostPullRequest,
  isOnHost,
  normaliseBaseUrl,
  openHostPullRequest,
  type RemoteHost,
} from './git-remote-hosts';

export const GIT_REMOTE_SLUG = 'git-remote';

/**
 * A repository on a git host that is not GitHub: Forgejo, Gitea, GitLab, or
 * any other host that serves git over HTTP or HTTPS.
 *
 * One integration account is one connection to one host. The account keeps
 * the address of the host and the user name in `integrationConfiguration`,
 * and the repositories in `settings`. The credential store keeps the token,
 * sealed, under the id of the account.
 *
 * The server sends the token only to the address of the connected host. It
 * refuses a clone address on any other host, and it turns off git redirects,
 * so a redirect cannot take the token to a different host.
 *
 * A host does not send webhooks to Vantik, so the mirror fetches when it is
 * old. On Forgejo, Gitea and GitLab, a pushed branch becomes a pull request.
 * On a generic host, the pushed branch is the handback.
 */
@Injectable()
export class GitRemoteSource implements GitSource {
  readonly slug = GIT_REMOTE_SLUG;
  readonly notifies = false;

  constructor(private credentials: CredentialsService) {}

  async fetchRemote(repo: SourceRepo): Promise<GitRemote> {
    const host = hostOf(repo);
    const url = this.cloneUrl(repo, host);
    const token = await this.token(repo);

    return token
      ? tokenRemote(url, token, host.username, { followRedirects: false })
      : anonymousRemote(url);
  }

  async pushRemote(repo: SourceRepo): Promise<GitRemote> {
    const host = hostOf(repo);
    const url = this.cloneUrl(repo, host);
    const token = await this.token(repo);

    if (!token) {
      throw new Error(
        `The connection to ${host.baseUrl} has no token, so the server cannot push to ${repo.fullName}. Add a token in the workspace settings.`,
      );
    }

    return tokenRemote(url, token, host.username, { followRedirects: false });
  }

  /**
   * The default branch that the host gave when the repository was added. A
   * remote advertises its default branch as HEAD, so null is also correct.
   */
  async defaultBranch(repo: SourceRepo): Promise<string | null> {
    const branch = repo.listing.defaultBranch;

    return typeof branch === 'string' && branch ? branch : null;
  }

  opensChangeRequests(repo: SourceRepo): boolean {
    return hostOf(repo).kind !== 'generic';
  }

  async openChangeRequest(
    repo: SourceRepo,
    request: ChangeRequest,
  ): Promise<string | undefined> {
    const host = hostOf(repo);
    const token = await this.token(repo);

    if (!token || host.kind === 'generic') {
      return undefined;
    }

    return await openHostPullRequest(host, token, {
      fullName: repo.fullName,
      repositoryId: repo.externalRepoId,
      branch: request.branch,
      baseBranch: request.baseBranch,
      title: request.title,
      body: request.body,
    });
  }

  async closeChangeRequest(
    repo: SourceRepo,
    url: string,
    comment: string,
  ): Promise<ChangeRequestClosed> {
    const host = hostOf(repo);
    const number = changeRequestNumber(
      repo,
      url,
      new URL(host.baseUrl).pathname.replace(/\/+$/, ''),
    );
    const token = await this.token(repo);

    // The URL has to be on the connected host as well as name the
    // repository: the token goes with the request.
    if (number === null || !isOnHost(url, host.baseUrl)) {
      throw new Error(`${url} is not a pull request of ${repo.fullName}.`);
    }
    if (!token || host.kind === 'generic') {
      throw new Error(
        `The connection to ${host.baseUrl} cannot close pull requests.`,
      );
    }

    return await closeHostPullRequest(host, token, {
      fullName: repo.fullName,
      repositoryId: repo.externalRepoId,
      number,
      comment,
    });
  }

  /**
   * The account that owns the token, which the server read from the host
   * when the token was saved. On a well-run host it is a bot user, so the
   * commit names the bot and not the person who connected the host.
   */
  commitAuthor(repo: SourceRepo): CommitIdentity | null {
    const { authorName, authorEmail } = repo.config;

    return typeof authorName === 'string' &&
      authorName &&
      typeof authorEmail === 'string' &&
      authorEmail
      ? { name: authorName, email: authorEmail }
      : null;
  }

  location(repo: SourceRepo): string {
    const web = repo.listing.webUrl;

    if (typeof web === 'string' && web) {
      return web;
    }

    const clone = repo.listing.cloneUrl;

    return typeof clone === 'string' ? clone : repo.fullName;
  }

  private async token(repo: SourceRepo): Promise<string | null> {
    return await this.credentials.revealRemoteToken(
      repo.workspaceId,
      repo.integrationAccountId,
    );
  }

  /**
   * The clone address from the entry, checked again on every use. The entry
   * is JSON in the account settings, so this method does not trust the check
   * that the server did when somebody added the repository.
   */
  private cloneUrl(repo: SourceRepo, host: RemoteHost): string {
    const url = repo.listing.cloneUrl;

    if (typeof url !== 'string' || !isOnHost(url, host.baseUrl)) {
      throw new Error(
        `${repo.fullName} has no clone address on ${host.baseUrl}. Remove the repository and add it again.`,
      );
    }

    return url;
  }
}

/** This function reads the host settings of the connection of a repository. */
export function hostOf(repo: Pick<SourceRepo, 'config'>): RemoteHost {
  const kind = repo.config.kind as GitRemoteKind;
  const baseUrl =
    typeof repo.config.baseUrl === 'string'
      ? normaliseBaseUrl(repo.config.baseUrl)
      : null;

  if (!GIT_REMOTE_KINDS.includes(kind) || !baseUrl) {
    throw new Error(
      'The git remote connection has no valid host. Connect the host again.',
    );
  }

  return {
    kind,
    baseUrl,
    username:
      typeof repo.config.username === 'string' && repo.config.username
        ? repo.config.username
        : 'git',
  };
}
