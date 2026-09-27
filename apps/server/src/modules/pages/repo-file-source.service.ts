import { Injectable } from '@nestjs/common';
import { IntegrationPayloadEventType } from '@vantikhq/types';
import { localHead, readLocalFile } from 'integrations/local-repo/git-files';
import { LOCAL_REPO_SLUG } from 'integrations/local-repo/repositories';
import {
  COMMIT_SHA,
  type RepoFileRead,
  type RepoHead,
} from 'integrations/repo-files';
import { PrismaService } from 'nestjs-prisma';

import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LocalRepoService } from 'modules/local-repo/local-repo.service';

/** A module's repository, as much of the `ModuleRepo` row as reading needs. */
export interface CitedRepo {
  id: string;
  fullName: string;
  externalRepoId: string;
  integrationAccountId: string | null;
  workspaceId: string;
}

/**
 * Reads a path at a ref for a module's repository, whatever the repository's
 * source.
 *
 * One interface for every source, so what a citation check does never depends
 * on where the code lives. A repository whose source cannot be asked answers
 * `unknown`, never `missing`: the check is then retried, and the claim is not
 * held against the code for the server's failure to read it.
 */
export interface RepoFileSource {
  read(repo: CitedRepo, path: string, ref: string): Promise<RepoFileRead>;
  /** The commit at the head of the repository's default branch. */
  head(repo: CitedRepo): Promise<RepoHead>;
}

const GITHUB_SLUG = 'github';

@Injectable()
export default class RepoFileSourceService implements RepoFileSource {
  constructor(
    private prisma: PrismaService,
    private integrations: IntegrationsService,
    private localRepo: LocalRepoService,
  ) {}

  async read(
    repo: CitedRepo,
    path: string,
    ref: string,
  ): Promise<RepoFileRead> {
    try {
      const slug = await this.sourceOf(repo);

      if (slug === GITHUB_SLUG) {
        return asFileRead(
          await this.integrations.loadIntegration(GITHUB_SLUG, {
            event: IntegrationPayloadEventType.READ_REPO_FILE,
            integrationAccountId: repo.integrationAccountId,
            workspaceId: repo.workspaceId,
            data: { fullName: repo.fullName, path, ref },
          }),
        );
      }

      if (slug === LOCAL_REPO_SLUG) {
        return await readLocalFile(await this.checkoutOf(repo), path, ref);
      }

      return noSource(repo);
    } catch (error) {
      return failed(error);
    }
  }

  async head(repo: CitedRepo): Promise<RepoHead> {
    try {
      const slug = await this.sourceOf(repo);

      if (slug === GITHUB_SLUG) {
        return asHead(
          await this.integrations.loadIntegration(GITHUB_SLUG, {
            event: IntegrationPayloadEventType.RESOLVE_REPO_HEAD,
            integrationAccountId: repo.integrationAccountId,
            workspaceId: repo.workspaceId,
            data: { fullName: repo.fullName },
          }),
        );
      }

      if (slug === LOCAL_REPO_SLUG) {
        return await localHead(await this.checkoutOf(repo));
      }

      return noSource(repo);
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * The source of a repository, from the integration account that holds it.
   * Only an account in the repository's own workspace counts, so a row naming
   * another workspace's account reads nothing.
   */
  private async sourceOf(repo: CitedRepo): Promise<string | null> {
    if (!repo.integrationAccountId) {
      return null;
    }

    const account = await this.prisma.integrationAccount.findFirst({
      where: {
        id: repo.integrationAccountId,
        workspaceId: repo.workspaceId,
        deleted: null,
      },
      select: { integrationDefinition: { select: { slug: true } } },
    });

    return account?.integrationDefinition?.slug ?? null;
  }

  private checkoutOf(repo: CitedRepo): Promise<string | null> {
    return this.localRepo.pathOf(repo.workspaceId, repo.externalRepoId);
  }
}

function noSource(repo: CitedRepo): { unknown: true; reason: string } {
  return {
    unknown: true,
    reason: `${repo.fullName} has no source this server can read files from`,
  };
}

/**
 * A source that threw. `loadIntegration` does not catch a plugin's rejected
 * promise, so a GitHub that cannot be reached while a token is refreshed
 * arrives here as a throw. It is the source failing, not the file, and a write
 * must not fail with it.
 */
function failed(error: unknown): { unknown: true; reason: string } {
  return {
    unknown: true,
    reason: `the repository could not be read: ${(error as Error)?.message ?? error}`,
  };
}

/**
 * A plugin's answer, trusted only for its shape. `loadIntegration` returns
 * undefined when it caught the plugin failing, which is not the file either.
 */
function asFileRead(answer: unknown): RepoFileRead {
  const value = answer as Partial<{
    content: unknown;
    missing: unknown;
    reason: unknown;
  }>;

  if (typeof value?.content === 'string') {
    return { content: value.content };
  }

  if (value?.missing === true) {
    return { missing: true };
  }

  return {
    unknown: true,
    reason:
      typeof value?.reason === 'string'
        ? value.reason
        : 'the integration did not answer',
  };
}

function asHead(answer: unknown): RepoHead {
  const value = answer as Partial<{ sha: unknown; reason: unknown }>;

  if (typeof value?.sha === 'string' && COMMIT_SHA.test(value.sha)) {
    return { sha: value.sha };
  }

  return {
    unknown: true,
    reason:
      typeof value?.reason === 'string'
        ? value.reason
        : 'the integration did not answer',
  };
}
