import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { SessionContainer } from 'supertokens-node/recipe/session';

import {
  assertIssueCommentInWorkspace,
  assertIssueInWorkspace,
  assertTeamInWorkspace,
  resolveWorkspaceId,
} from 'common/workspace-access';

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

    const userId = session.getUserId();
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      session.getAccessTokenPayload().workspaceId,
      request.query?.workspaceId,
    );

    const { issueId, issueCommentId } = request.params ?? {};

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

    return true;
  }
}

function unique(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.filter(Boolean))] as string[];
}
