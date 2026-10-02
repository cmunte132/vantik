import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type AddGitRemoteRepositoryDto,
  type AvailableGitRemoteRepository,
  type ConnectGitRemoteDto,
  type GitRemoteConnection,
  type GitRemoteRepository,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveAdminWorkspaceId } from 'common/workspace-access';

import { CredentialsService } from 'modules/agent-runs/credentials/credentials.service';
import { git, GitCommandError } from 'modules/git/git-command';
import { type SourceRepo } from 'modules/git/git-source';
import {
  cloneUrlFor,
  getHostRepository,
  hostErrorReason,
  type HostIdentity,
  isOnHost,
  listHostRepositories,
  normaliseBaseUrl,
  type RemoteHost,
  whoAmI,
} from 'modules/git/sources/git-remote-hosts';
import {
  GIT_REMOTE_SLUG,
  GitRemoteSource,
  hostOf,
} from 'modules/git/sources/git-remote.source';

/** How long the check of a new repository can take. */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * The git hosts that a workspace connected, and the repositories it takes
 * from each host.
 *
 * One connection is one integration account. The account keeps the host in
 * `integrationConfiguration` and the repositories in `settings`, in the same
 * shape as a local repository. The picker of a module, the mirror and the
 * agent runs then read a remote repository as they read any other.
 *
 * Only an admin can connect a host or add a repository. The token can push to
 * every repository that it can read, so the admin chooses what the workspace
 * can write to. Any member can read the list, because the list holds no
 * secret.
 */
@Injectable()
export class GitRemoteService {
  constructor(
    private prisma: PrismaService,
    private credentials: CredentialsService,
    private source: GitRemoteSource,
  ) {}

  async list(workspaceId: string): Promise<GitRemoteConnection[]> {
    const accounts = await this.prisma.integrationAccount.findMany({
      where: {
        workspaceId,
        deleted: null,
        integrationDefinition: { slug: GIT_REMOTE_SLUG },
      },
      orderBy: { createdAt: 'asc' },
    });
    const hints = await this.credentials.remoteTokenHints(workspaceId);

    return accounts.map((account) => toConnection(account, hints));
  }

  /**
   * This method connects a host, or it changes the user name and the token of
   * a host that the workspace already connected. A connection that the
   * workspace removed comes back with its old repositories.
   */
  async connect(
    workspaceId: string,
    userId: string,
    dto: ConnectGitRemoteDto,
  ): Promise<GitRemoteConnection> {
    const target = await resolveAdminWorkspaceId(
      this.prisma,
      userId,
      workspaceId,
    );
    const baseUrl = normaliseBaseUrl(dto.baseUrl ?? '');

    if (!baseUrl) {
      throw new BadRequestException(
        `${dto.baseUrl} is not an http or https address with no user name, query or fragment.`,
      );
    }

    const token = dto.token?.trim() || null;
    let username = dto.username?.trim() || '';
    // The account that owns the token. Commits pushed through the connection
    // name it as their author, so a bot token puts the bot in the history.
    let identity: HostIdentity | null = null;

    if (token && dto.kind !== 'generic') {
      try {
        identity = await whoAmI(
          { kind: dto.kind, baseUrl, username: '' },
          token,
        );
      } catch (error) {
        throw new BadRequestException(
          `Vantik cannot use this token on ${baseUrl}: ${hostErrorReason(error)}.`,
        );
      }

      username ||= identity?.login ?? '';
    }

    const definition = await this.definition();
    const config = {
      kind: dto.kind,
      baseUrl,
      username: username || 'git',
      ...(identity
        ? { authorName: identity.name, authorEmail: identity.email }
        : {}),
    };

    const account = await this.prisma.integrationAccount.upsert({
      where: {
        accountId_integrationDefinitionId_workspaceId: {
          accountId: baseUrl,
          integrationDefinitionId: definition.id,
          workspaceId: target,
        },
      },
      create: {
        accountId: baseUrl,
        integrationDefinitionId: definition.id,
        workspaceId: target,
        integratedById: userId,
        integrationConfiguration: config,
        settings: { repositories: [] },
      },
      update: { integrationConfiguration: config, deleted: null },
    });

    if (token) {
      await this.credentials.putRemoteToken({
        workspaceId: target,
        integrationAccountId: account.id,
        secret: token,
        createdById: userId,
      });
    }

    return toConnection(
      account,
      await this.credentials.remoteTokenHints(target),
    );
  }

  /**
   * This method removes a connection and its token. A module that links a
   * repository of the connection keeps the link, but the link resolves to
   * nothing until somebody connects the host again.
   */
  async disconnect(
    workspaceId: string,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    const target = await resolveAdminWorkspaceId(
      this.prisma,
      userId,
      workspaceId,
    );
    const account = await this.account(target, connectionId);

    await this.prisma.integrationAccount.update({
      where: { id: account.id },
      data: { deleted: new Date() },
    });
    await this.credentials.removeRemoteToken(target, account.id);
  }

  /** The repositories that the host offers, for the add picker. */
  async available(
    workspaceId: string,
    connectionId: string,
  ): Promise<AvailableGitRemoteRepository[]> {
    const account = await this.account(workspaceId, connectionId);
    const host = hostOf({ config: configOf(account) });
    const token = await this.credentials.revealRemoteToken(
      workspaceId,
      account.id,
    );
    const added = new Set(repositoriesOf(account).map((entry) => entry.id));

    try {
      const found = await listHostRepositories(host, token);

      return found.map((repo) => ({
        id: repo.id,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        private: repo.private,
        added: added.has(repo.id),
      }));
    } catch (error) {
      throw new BadRequestException(
        `Vantik cannot list the repositories on ${host.baseUrl}: ${hostErrorReason(error)}.`,
      );
    }
  }

  /**
   * This method adds one repository to a connection. Before it writes, it
   * runs `git ls-remote` with the token of the connection. A repository that
   * the server cannot fetch never gets into the list.
   */
  async addRepository(
    workspaceId: string,
    userId: string,
    connectionId: string,
    dto: AddGitRemoteRepositoryDto,
  ): Promise<GitRemoteRepository> {
    const target = await resolveAdminWorkspaceId(
      this.prisma,
      userId,
      workspaceId,
    );
    const account = await this.account(target, connectionId);
    const config = configOf(account);
    const host = hostOf({ config });
    const token = await this.credentials.revealRemoteToken(target, account.id);

    const entry =
      host.kind === 'generic'
        ? genericEntry(host, dto)
        : await this.hostEntry(host, token, dto);

    const repositories = repositoriesOf(account);

    if (repositories.some((repo) => repo.id === entry.id)) {
      throw new BadRequestException(
        `This connection already has ${entry.fullName}.`,
      );
    }

    const head = await this.check(
      {
        workspaceId: target,
        integrationAccountId: account.id,
        accountId: account.accountId ?? '',
        externalRepoId: entry.id,
        fullName: entry.fullName,
        listing: { ...entry },
        config,
      },
      host,
    );

    const added: GitRemoteRepository = {
      ...entry,
      defaultBranch: entry.defaultBranch ?? head ?? undefined,
    };

    await this.writeRepositories(account.id, [...repositories, added]);

    return added;
  }

  async removeRepository(
    workspaceId: string,
    userId: string,
    connectionId: string,
    repositoryId: string,
  ): Promise<GitRemoteRepository> {
    const target = await resolveAdminWorkspaceId(
      this.prisma,
      userId,
      workspaceId,
    );
    const account = await this.account(target, connectionId);
    const repositories = repositoriesOf(account);
    const repository = repositories.find((repo) => repo.id === repositoryId);

    if (!repository) {
      throw new NotFoundException('This connection has no such repository.');
    }

    await this.writeRepositories(
      account.id,
      repositories.filter((repo) => repo.id !== repositoryId),
    );

    return repository;
  }

  private async hostEntry(
    host: RemoteHost,
    token: string | null,
    dto: AddGitRemoteRepositoryDto,
  ): Promise<Omit<GitRemoteRepository, 'addedAt'> & { addedAt: string }> {
    const fullName = (dto.fullName ?? '').trim().replace(/^\/+|\/+$/g, '');

    if (!/^[^/\s]+(\/[^/\s]+)+$/.test(fullName) || fullName.includes('..')) {
      throw new BadRequestException(
        'Give the repository as owner/name, as the host shows it.',
      );
    }

    try {
      const repo = await getHostRepository(host, token, fullName);

      return {
        id: repo.id,
        fullName: repo.fullName,
        cloneUrl: cloneUrlFor(host, repo.fullName),
        webUrl: repo.webUrl,
        defaultBranch: repo.defaultBranch,
        addedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new BadRequestException(
        `Vantik cannot read ${fullName} on ${host.baseUrl}: ${hostErrorReason(error)}.`,
      );
    }
  }

  /**
   * This method fetches the refs of the repository, as the mirror will. It
   * returns the branch that HEAD points to, or null.
   */
  private async check(
    repo: SourceRepo,
    host: RemoteHost,
  ): Promise<string | null> {
    const remote = await this.source.fetchRemote(repo);

    try {
      const output = await git(['ls-remote', '--symref', remote.url, 'HEAD'], {
        remote,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      const match = output.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m);

      return match ? match[1] : null;
    } catch (error) {
      const reason =
        error instanceof GitCommandError ? error.message : String(error);

      throw new BadRequestException(
        `Vantik cannot fetch ${repo.fullName} from ${host.baseUrl}. ${reason}`,
      );
    } finally {
      await remote.dispose();
    }
  }

  private async writeRepositories(
    accountId: string,
    repositories: GitRemoteRepository[],
  ) {
    await this.prisma.integrationAccount.update({
      where: { id: accountId },
      data: {
        settings: {
          repositories,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async account(workspaceId: string, connectionId: string) {
    const account = await this.prisma.integrationAccount.findFirst({
      where: {
        id: connectionId,
        workspaceId,
        deleted: null,
        integrationDefinition: { slug: GIT_REMOTE_SLUG },
      },
    });

    if (!account) {
      throw new NotFoundException('This workspace has no such git remote.');
    }

    return account;
  }

  private async definition() {
    const definition = await this.prisma.integrationDefinitionV2.findFirst({
      where: { slug: GIT_REMOTE_SLUG, deleted: null },
      select: { id: true },
    });

    if (!definition) {
      throw new BadRequestException(
        'This deployment has no git remote integration. Restart the server, because the seed writes the row at start.',
      );
    }

    return definition;
  }
}

/**
 * This function makes the entry for a repository on a generic host. The clone
 * address must be on the host, because the server sends the token to it.
 */
function genericEntry(
  host: RemoteHost,
  dto: AddGitRemoteRepositoryDto,
): GitRemoteRepository {
  const cloneUrl = (dto.cloneUrl ?? '').trim();

  if (!isOnHost(cloneUrl, host.baseUrl)) {
    throw new BadRequestException(
      `Give the clone address of a repository under ${host.baseUrl}/.`,
    );
  }

  const fullName = new URL(cloneUrl).pathname
    .slice(new URL(host.baseUrl).pathname.replace(/\/+$/, '').length)
    .replace(/^\/+/, '')
    .replace(/\.git$/, '');

  return {
    id: randomUUID(),
    fullName: fullName || cloneUrl,
    cloneUrl,
    addedAt: new Date().toISOString(),
  };
}

interface AccountRow {
  id: string;
  accountId: string | null;
  settings: Prisma.JsonValue;
  integrationConfiguration: Prisma.JsonValue;
  createdAt: Date;
}

function toConnection(
  account: AccountRow,
  hints: Map<string, string>,
): GitRemoteConnection {
  const config = configOf(account);

  return {
    id: account.id,
    kind: config.kind as GitRemoteConnection['kind'],
    baseUrl: String(config.baseUrl ?? account.accountId ?? ''),
    username: String(config.username ?? 'git'),
    author: authorOf(config),
    hasToken: hints.has(account.id),
    tokenHint: hints.get(account.id) ?? null,
    repositories: repositoriesOf(account),
    createdAt: account.createdAt.toISOString(),
  };
}

/** The bot account that commits pushed through the connection name. */
function authorOf(config: Record<string, unknown>): string | null {
  const { authorName, authorEmail } = config;

  return typeof authorName === 'string' && typeof authorEmail === 'string'
    ? `${authorName} <${authorEmail}>`
    : null;
}

function configOf(account: AccountRow): Record<string, unknown> {
  const value = account.integrationConfiguration;

  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function repositoriesOf(account: AccountRow): GitRemoteRepository[] {
  const settings = account.settings as { repositories?: unknown } | null;

  return Array.isArray(settings?.repositories)
    ? (settings.repositories as GitRemoteRepository[])
    : [];
}
