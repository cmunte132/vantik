import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { getBotToken } from 'integrations/github/get-token';
import { githubHeaders } from 'integrations/github/types';
import { PluginContextFactory } from 'plugins/plugin-context.factory';

import { CredentialsService } from 'modules/agent-runs/credentials/credentials.service';

import { tokenRemote, type GitRemote } from '../git-command';
import {
  type ChangeRequest,
  type GitSource,
  type SourceRepo,
} from '../git-source';

const GITHUB_SLUG = 'github';

/**
 * A repository on GitHub, reached through the workspace's app installation.
 *
 * The deepest of the three tiers: GitHub sends webhooks, so the mirror is
 * fetched when a branch moves, and a pushed branch becomes a pull request.
 *
 * The fetch uses the installation token, which every connected repository
 * grants. The push uses the workspace's git token when one is stored, so the
 * branch and the pull request carry the identity the workspace chose, and the
 * installation token otherwise.
 */
@Injectable()
export class GithubSource implements GitSource {
  readonly slug = GITHUB_SLUG;
  readonly notifies = true;

  constructor(
    private contextFactory: PluginContextFactory,
    private credentials: CredentialsService,
  ) {}

  async fetchRemote(repo: SourceRepo): Promise<GitRemote> {
    return tokenRemote(this.url(repo), await this.installationToken(repo));
  }

  async pushRemote(repo: SourceRepo): Promise<GitRemote> {
    return tokenRemote(this.url(repo), await this.pushToken(repo));
  }

  async openChangeRequest(
    repo: SourceRepo,
    request: ChangeRequest,
  ): Promise<string | undefined> {
    const { data } = await axios.post(
      `https://api.github.com/repos/${repo.fullName}/pulls`,
      {
        title: request.title,
        body: request.body,
        head: request.branch,
        base: request.baseBranch,
      },
      {
        headers: {
          ...githubHeaders,
          Authorization: `Bearer ${await this.pushToken(repo)}`,
        },
        timeout: 30_000,
      },
    );

    return typeof data?.html_url === 'string' ? data.html_url : undefined;
  }

  location(repo: SourceRepo): string {
    return `https://github.com/${repo.fullName}`;
  }

  private url(repo: SourceRepo): string {
    return `https://github.com/${repo.fullName}.git`;
  }

  private async pushToken(repo: SourceRepo): Promise<string> {
    const stored = await this.credentials.reveal(repo.workspaceId, 'GIT_TOKEN');

    return stored?.secret ?? (await this.installationToken(repo));
  }

  private async installationToken(repo: SourceRepo): Promise<string> {
    const token = await getBotToken(
      this.contextFactory.build(GITHUB_SLUG, repo.workspaceId),
      repo.integrationAccountId,
    );

    if (!token) {
      throw new Error(
        `The GitHub app gave no token for ${repo.fullName}. Reconnect GitHub in the workspace settings.`,
      );
    }

    return token;
  }
}
