import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { SessionContainer } from 'supertokens-node/recipe/session';

import {
  assertChecklistItemInWorkspace,
  assertCycleInWorkspace,
  assertIssueCommentInWorkspace,
  assertIssueInWorkspace,
  assertPageEntryInWorkspace,
  assertPageInWorkspace,
  assertTeamInWorkspace,
  resolveWorkspaceId,
} from 'common/workspace-access';

import { getAppUserId } from 'modules/auth/session-user';

/**
 * Proves that the issue, comment or team named in a request belongs to a
 * workspace the caller is a member of.
 *
 * AuthGuard proves only that the caller is *some* valid user, so any endpoint
 * addressing a row by id — `GET /issues/:issueId`, `POST /issues/:issueId`,
 * the comment routes — served or modified that row whatever workspace it sat
 * in. Reads leaked issue contents; the writes were worse, since a foreign id
 * could be updated, deleted or moved.
 *
 * The check lives at the HTTP boundary rather than in the services because
 * that is where the untrusted id arrives. The same service methods are called
 * internally — `updateIssueApi` from projects.service, `moveIssue` from itself
 * for sub-issues — with no user session and a legitimate need to cross
 * workspaces, so a membership check inside them would be wrong.
 *
 * Use after AuthGuard, which populates the session this reads.
 */
@Injectable()
export class WorkspaceResourceGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const session = request.session as SessionContainer;

    const userId = getAppUserId(session);
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      session.getAccessTokenPayload().workspaceId,
      request.query?.workspaceId,
    );

    const { issueId, issueCommentId, checklistItemId, pageEntryId, cycleId } =
      request.params ?? {};

    // The bulk routes carry their ids inside a body array, one per issue, so
    // the path and query alone do not describe everything the request touches.
    const bulkIssues = Array.isArray(request.body?.issues)
      ? request.body.issues
      : [];

    // Comment creation names its issue in the query rather than the path, so
    // a guard reading only params would let a caller comment on an issue in
    // another workspace.
    const issueIds = unique([
      issueId,
      request.query?.issueId,
      ...bulkIssues.map((issue: { issueId?: string }) => issue?.issueId),
    ]);

    // teamId selects the team a write lands in: a query param on update, the
    // body on create and move, and per-entry on bulk create.
    const teamIds = unique([
      request.query?.teamId,
      request.body?.teamId,
      ...bulkIssues.map((issue: { teamId?: string }) => issue?.teamId),
    ]);

    for (const id of issueIds) {
      await assertIssueInWorkspace(this.prisma, id, workspaceId);
    }

    for (const id of teamIds) {
      await assertTeamInWorkspace(this.prisma, id, workspaceId);
    }

    if (issueCommentId) {
      await assertIssueCommentInWorkspace(
        this.prisma,
        issueCommentId,
        workspaceId,
      );
    }

    // Same shape as the checklist items below: start, complete and delete name
    // the cycle by id and nothing else, and completing one moves other people's
    // issues around.
    if (cycleId) {
      await assertCycleInWorkspace(this.prisma, cycleId, workspaceId);
    }

    // Checklist item updates and deletes address the row by id alone, with no
    // issueId anywhere in the request, so without this a foreign item could be
    // ticked or removed.
    if (checklistItemId) {
      await assertChecklistItemInWorkspace(
        this.prisma,
        checklistItemId,
        workspaceId,
      );
    }

    // Pages are reached by path on read and edit, and by query when appending
    // an entry — the same split the comment routes have, and the same reason to
    // check both rather than only params. A `parentId` in the body is
    // deliberately not checked here: the issue routes use that name for an
    // issue, so the page reparent path validates its own parent instead.
    const pageIds = unique([request.params?.pageId, request.query?.pageId]);

    for (const id of pageIds) {
      await assertPageInWorkspace(this.prisma, id, workspaceId);
    }

    // Entry triage addresses the row by id alone, with no page anywhere in the
    // request, so without this a foreign fact could be accepted or archived.
    const entryIds = unique([
      pageEntryId,
      request.body?.supersedesId,
      ...(Array.isArray(request.body?.entryIds) ? request.body.entryIds : []),
    ]);

    for (const id of entryIds) {
      await assertPageEntryInWorkspace(this.prisma, id, workspaceId);
    }

    return true;
  }
}

function unique(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.filter(Boolean))] as string[];
}
