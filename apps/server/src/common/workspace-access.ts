import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

/**
 * Resolves the workspace a request should read, and proves the caller belongs
 * to it.
 *
 * A user can be a member of several workspaces (`UsersOnWorkspaces` is a
 * many-to-many, and the webapp picks the current one from the URL slug), so a
 * request legitimately names the workspace it wants. Two things then go wrong
 * if that name is trusted or ignored:
 *
 * - trusting it lets any authenticated caller read any workspace, which is what
 *   made the issue, search and sync reads leak across tenants
 * - ignoring it in favour of the session's workspace silently serves the wrong
 *   workspace's data, because the access token carries only the user's *first*
 *   workspace
 *
 * So the requested workspace is honoured, but only after checking membership.
 * With no workspace requested the session's own is used — and still checked,
 * so a token issued before the user left a workspace cannot outlive the
 * membership it asserts.
 */
export async function resolveWorkspaceId(
  prisma: PrismaService,
  userId: string,
  sessionWorkspaceId: string,
  requestedWorkspaceId?: string,
): Promise<string> {
  const workspaceId = requestedWorkspaceId || sessionWorkspaceId;

  // An empty workspaceId drops out of a Prisma `where` and turns a scoped read
  // into an unscoped one, so it must never reach a query.
  if (!workspaceId || !userId) {
    throw new UnauthorizedException({
      message: 'No workspace is associated with this session',
    });
  }

  const membership = await prisma.usersOnWorkspaces.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { status: true },
  });

  if (!membership || membership.status !== 'ACTIVE') {
    throw new UnauthorizedException({
      message: 'You do not have access to this workspace',
    });
  }

  return workspaceId;
}

/**
 * Resolves the workspace a privileged write should land in, and proves the
 * caller administers *that* workspace.
 *
 * AdminGuard reads the role off the access token, which carries the user's first
 * workspace and its role there. For anything that writes into a named workspace
 * that is the wrong question twice over: someone who administers workspace A but
 * is only a member of B passes the guard while browsing B, and `@Workspace()`
 * then hands the handler A — so the write lands in a workspace the person was
 * not looking at, with an admin check that was never about the target. Both come
 * from the membership row instead.
 */
export async function resolveAdminWorkspaceId(
  prisma: PrismaService,
  userId: string,
  sessionWorkspaceId: string,
  requestedWorkspaceId?: string,
): Promise<string> {
  const workspaceId = requestedWorkspaceId || sessionWorkspaceId;

  if (!workspaceId || !userId) {
    throw new UnauthorizedException({
      message: 'No workspace is associated with this session',
    });
  }

  const membership = await prisma.usersOnWorkspaces.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { status: true, role: true },
  });

  if (!membership || membership.status !== 'ACTIVE') {
    throw new UnauthorizedException({
      message: 'You do not have access to this workspace',
    });
  }

  if (membership.role !== RoleEnum.ADMIN) {
    throw new ForbiddenException({
      message: 'Only workspace admins can do this',
    });
  }

  return workspaceId;
}

/**
 * Proves an issue belongs to the given workspace.
 *
 * Not-found rather than forbidden is deliberate: a foreign id and a
 * non-existent one should be indistinguishable, or the error itself confirms
 * which ids exist in other workspaces.
 */
export async function assertIssueInWorkspace(
  prisma: PrismaService,
  issueId: string,
  workspaceId: string,
): Promise<void> {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, deleted: null, team: { workspaceId } },
    select: { id: true },
  });

  if (!issue) {
    throw new NotFoundException({ message: `Issue ${issueId} not found` });
  }
}

/** Proves an issue comment's issue belongs to the given workspace. */
export async function assertIssueCommentInWorkspace(
  prisma: PrismaService,
  issueCommentId: string,
  workspaceId: string,
): Promise<void> {
  const comment = await prisma.issueComment.findFirst({
    where: {
      id: issueCommentId,
      deleted: null,
      issue: { team: { workspaceId } },
    },
    select: { id: true },
  });

  if (!comment) {
    throw new NotFoundException({
      message: `Issue comment ${issueCommentId} not found`,
    });
  }
}

/** Proves a checklist item's issue belongs to the given workspace. */
export async function assertChecklistItemInWorkspace(
  prisma: PrismaService,
  checklistItemId: string,
  workspaceId: string,
): Promise<void> {
  const checklistItem = await prisma.checklistItem.findFirst({
    where: {
      id: checklistItemId,
      deleted: null,
      issue: { team: { workspaceId } },
    },
    select: { id: true },
  });

  if (!checklistItem) {
    throw new NotFoundException({
      message: `Checklist item ${checklistItemId} not found`,
    });
  }
}

/** Proves a page belongs to the given workspace. */
export async function assertPageInWorkspace(
  prisma: PrismaService,
  pageId: string,
  workspaceId: string,
): Promise<void> {
  const page = await prisma.page.findFirst({
    where: { id: pageId, deleted: null, workspaceId },
    select: { id: true },
  });

  if (!page) {
    throw new NotFoundException({ message: `Page ${pageId} not found` });
  }
}

/**
 * Proves an entry's page belongs to the given workspace.
 *
 * Entry triage addresses the row by id alone — no page anywhere in the request
 * — so without this a caller could accept, archive or rewrite a fact asserted
 * in someone else's workspace.
 */
export async function assertPageEntryInWorkspace(
  prisma: PrismaService,
  pageEntryId: string,
  workspaceId: string,
): Promise<void> {
  const entry = await prisma.pageEntry.findFirst({
    where: {
      id: pageEntryId,
      deleted: null,
      page: { workspaceId, deleted: null },
    },
    select: { id: true },
  });

  if (!entry) {
    throw new NotFoundException({
      message: `Page entry ${pageEntryId} not found`,
    });
  }
}

/**
 * Proves a cycle's team belongs to the given workspace.
 *
 * The cycle routes address the row by id alone — start, complete and delete
 * name no team anywhere in the request — so without this a caller could
 * complete a sprint, or move its unfinished issues, in someone else's
 * workspace.
 */
export async function assertCycleInWorkspace(
  prisma: PrismaService,
  cycleId: string,
  workspaceId: string,
): Promise<void> {
  const cycle = await prisma.cycle.findFirst({
    where: { id: cycleId, deleted: null, team: { workspaceId } },
    select: { id: true },
  });

  if (!cycle) {
    throw new NotFoundException({ message: `Cycle ${cycleId} not found` });
  }
}

/**
 * Proves a team belongs to the given workspace.
 *
 * A teamId arrives as a query or body parameter on the create, update and move
 * paths, where it selects the team an issue lands in — so an unchecked one is a
 * cross-workspace write, not just a read.
 */
export async function assertTeamInWorkspace(
  prisma: PrismaService,
  teamId: string,
  workspaceId: string,
): Promise<void> {
  const team = await prisma.team.findFirst({
    where: { id: teamId, deleted: null, workspaceId },
    select: { id: true },
  });

  if (!team) {
    throw new NotFoundException({ message: `Team ${teamId} not found` });
  }
}
