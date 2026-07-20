import { UnauthorizedException } from '@nestjs/common';
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
