import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import AIRequestsService from 'modules/ai-requests/ai-requests.services';
import IssueCommentsService from 'modules/issue-comments/issue-comments.service';
import IssuesService from 'modules/issues/issues.service';
import LinkedIssueService from 'modules/linked-issue/linked-issue.service';
import { LoggerService } from 'modules/logger/logger.service';

import { type PluginContext, type PluginSpec } from './plugin.interface';

/**
 * Builds the context a plugin is given.
 *
 * Every capability here is a call the host makes on the plugin's behalf. The
 * plugin holds no client, no connection and no credential, which is the
 * property that lets the host decide where the plugin runs — in this process
 * now, in a forked worker or a sandbox later — without the plugin changing.
 *
 * Reads that are plain lookups go through Prisma; anything that *writes*
 * something the rest of the app watches goes through the owning service, so a
 * plugin creating an issue takes the same path a person does and the sync
 * engine, the notification queue and the history all see it. Writing those
 * through Prisma here would be faster and would silently skip all three.
 */
@Injectable()
export class PluginContextFactory {
  constructor(
    private prisma: PrismaService,
    private issuesService: IssuesService,
    private issueCommentsService: IssueCommentsService,
    private linkedIssueService: LinkedIssueService,
    private aiRequestsService: AIRequestsService,
  ) {}

  /**
   * A context for one invocation.
   *
   * `userId` is who the plugin acts as when it writes. A plugin has no session,
   * so this is the workflow user the action was provisioned with — passed in by
   * the caller rather than resolved here, because only the caller knows whether
   * this is a webhook, a schedule or a reaction to somebody's edit.
   */
  build(
    slug: string,
    workspaceId?: string,
    userId?: string,
    spec?: PluginSpec,
    accountId?: string,
  ): PluginContext {
    const logger = new LoggerService(`plugin:${slug}`);
    const prisma = this.prisma;

    return {
      workspaceId,

      log: {
        debug: (message, data) =>
          logger.debug({ message, where: `plugin:${slug}`, payload: data }),
        info: (message, data) =>
          logger.info({ message, where: `plugin:${slug}`, payload: data }),
        error: (message, data) =>
          logger.error({ message, where: `plugin:${slug}`, payload: data }),
      },

      // The only capability the current integrations need. Every `PrismaClient`
      // under `apps/server/src/integrations/` exists to read or write one of
      // these rows and nothing else.
      account: {
        get: (accountId) =>
          prisma.integrationAccount.findUnique({
            where: { id: accountId, deleted: null },
            include: { integrationDefinition: true, workspace: true },
          }),

        byDefinition: (definitionSlug, forWorkspaceId) =>
          prisma.integrationAccount.findFirst({
            where: {
              workspaceId: forWorkspaceId,
              deleted: null,
              integrationDefinition: { slug: definitionSlug },
            },
            include: { integrationDefinition: true },
          }),

        byWorkspaceSlug: (definitionSlug, workspaceSlug) =>
          prisma.integrationAccount.findFirst({
            where: {
              deleted: null,
              workspace: { slug: workspaceSlug },
              integrationDefinition: { slug: definitionSlug },
            },
            include: { integrationDefinition: true },
          }),

        upsert: (input) => {
          const {
            config: integrationConfiguration,
            userId: integratedById,
            settings,
            accountId,
            integrationDefinitionId,
            workspaceId: accountWorkspaceId,
            personal,
          } = input;

          return prisma.integrationAccount.upsert({
            where: {
              accountId_integrationDefinitionId_workspaceId: {
                accountId,
                integrationDefinitionId,
                workspaceId: accountWorkspaceId,
              },
            },
            create: {
              integrationConfiguration,
              settings,
              accountId,
              integratedById,
              workspaceId: accountWorkspaceId,
              integrationDefinitionId,
              personal,
              isActive: true,
            },
            update: {
              deleted: null,
              integrationConfiguration,
              settings,
              personal,
              isActive: true,
            },
          });
        },

        personal: (definitionSlug, forWorkspaceId, forUserId) =>
          prisma.integrationAccount.findFirst({
            where: {
              workspaceId: forWorkspaceId,
              integratedById: forUserId,
              personal: true,
              deleted: null,
              integrationDefinition: { slug: definitionSlug },
            },
            include: { integrationDefinition: true },
          }),

        update: (accountId, data) =>
          prisma.integrationAccount.update({ where: { id: accountId }, data }),
      },

      issues: {
        get: (issueId) => this.issuesService.getIssueById({ issueId }),
        getByNumber: (teamId, number) =>
          this.issuesService.getIssueByNumber(String(number), teamId),
        create: (teamId, input) =>
          this.issuesService.createIssueAPI({ ...input, teamId }, userId),
        update: (issueId, teamId, input) =>
          this.issuesService.updateIssueApi(
            { teamId },
            input,
            { issueId },
            userId,
          ),
      },

      comments: {
        get: (issueCommentId) =>
          this.issueCommentsService.getIssueComment({ issueCommentId }),
        replies: (issueCommentId) =>
          this.issueCommentsService.getReplyComments({ issueCommentId }),
        create: (input) =>
          this.issueCommentsService.createIssueComment(
            { issueId: input.issueId },
            userId,
            input,
          ),
        update: (issueCommentId, input) =>
          this.issueCommentsService.updateIssueComment(
            { issueCommentId },
            input,
          ),
      },

      links: {
        get: (linkId) => this.linkedIssueService.getLinkedIssue(linkId),
        bySource: (sourceId) =>
          this.linkedIssueService.getLinkedIssueBySourceId(sourceId),
        forIssue: (issueId) =>
          this.linkedIssueService.getLinkedIssueByIssueId(issueId),
        create: (input, asUserId) =>
          this.linkedIssueService.createLinkIssue(
            input,
            { issueId: input.issueId },
            asUserId ?? userId,
          ),
        update: (linkedIssueId, input) =>
          this.linkedIssueService.updateLinkIssue(
            { linkedIssueId },
            input,
            userId,
          ),
        updateBySource: (sourceId, input) =>
          this.linkedIssueService.updateLinkIssueBySource(
            sourceId,
            input,
            userId,
          ),
        comment: (sourceId) =>
          this.issueCommentsService.getLinkedCommentBySource(sourceId),
        createComment: (input) =>
          this.issueCommentsService.createLinkedComment(input),
      },

      // Plain reads, and all of them workspace-scoped. A plugin acts for one
      // workspace, so the scope is applied here rather than trusted to the
      // caller — the same reasoning the team-visibility work applied to the
      // routes.
      workspace: {
        teams: () => prisma.team.findMany({ where: { workspaceId } }),
        team: (teamId) => prisma.team.findUnique({ where: { id: teamId } }),
        teamByName: (name) =>
          prisma.team.findFirst({ where: { workspaceId, name } }),
        users: () =>
          prisma.usersOnWorkspaces.findMany({
            where: { workspaceId },
            include: { user: true },
          }),
        labels: () => prisma.label.findMany({ where: { workspaceId } }),
        workflows: (teamId) =>
          prisma.workflow.findMany({
            where: { teamId, deleted: null },
            orderBy: { position: 'asc' },
          }),
      },

      ai: {
        request: (input) =>
          this.aiRequestsService.getLLMRequest(input, workspaceId),
      },

      definitions: {
        get: (definitionSlug) =>
          prisma.integrationDefinitionV2.findFirst({
            where: { slug: definitionSlug, deleted: null },
          }),
      },

      /**
       * The plugin says what to call; the host decides whether it may, and
       * attaches the credential.
       *
       * Two refusals rather than one. Without a spec there is no allowlist, so
       * every call is refused — a plugin that has not declared where it may go
       * does not get to go anywhere. With a spec, the resolved host must be on
       * it, which is what stops a path like `//evil.com/x` or an absolute URL
       * from leaving the origin the plugin declared.
       */
      vendor: {
        fetch: async (target, init) => {
          if (!spec?.baseUrl) {
            throw new Error(
              `Plugin ${slug} has no baseUrl, so it cannot call a vendor.`,
            );
          }

          // The base URL carries a path (`/api/v10`), and `new URL('/x', base)`
          // resolves from the *origin* and drops it — so a plugin asking for
          // `/channels/1` would silently hit the wrong endpoint. Anchoring the
          // base with a trailing slash and stripping one leading slash from the
          // path keeps the version prefix.
          //
          // An absolute or protocol-relative value still resolves to its own
          // host, which is the point: it reaches the check below rather than
          // being quietly turned into a path segment.
          const base = new URL(
            spec.baseUrl.endsWith('/') ? spec.baseUrl : `${spec.baseUrl}/`,
          );
          // One leading slash is stripped, two are not. `//evil.com/x` is
          // protocol-relative, and stripping a slash would quietly turn it
          // into a path on the allowed host instead of letting the check
          // below refuse it. Silently rewriting somebody's escape attempt into
          // something harmless is worse than refusing it: it hides that a
          // plugin tried.
          const relative =
            target.startsWith('/') && !target.startsWith('//')
              ? target.slice(1)
              : target;
          const url = new URL(relative, base);

          if (!spec.egress?.includes(url.hostname)) {
            throw new Error(
              `Plugin ${slug} may not reach ${url.hostname}; ` +
                `its egress allows ${spec.egress?.join(', ') || 'nothing'}.`,
            );
          }

          const account = accountId
            ? await prisma.integrationAccount.findUnique({
                where: { id: accountId, deleted: null },
                include: { integrationDefinition: true },
              })
            : null;

          const authorization = spec.auth?.(account, init?.as);

          return await fetch(url.toString(), {
            ...init,
            headers: {
              ...(init?.headers ?? {}),
              ...(authorization ? { Authorization: authorization } : {}),
            },
          });
        },
      },
    };
  }
}
