import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { AuthSessionContext } from 'modules/auth/auth.interface';
import { getAppUserId } from 'modules/auth/session-user';

/**
 * Lets a workspace admin through.
 *
 * The role comes from the membership row of the workspace the request is for,
 * and not from the access token. The token carries the caller's first workspace
 * and the role there, so a member of several workspaces who administers only
 * the first would pass while acting on another, and an admin of a later
 * workspace would be refused in their own.
 *
 * The request is for the workspace named in `?workspaceId=`, or the session's
 * own when none is named. Handlers read their workspace from the session
 * (`@Workspace()`), so when the request names a different one the caller must
 * administer both. Otherwise the check would be about one workspace and the
 * write would land in the other.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const session = request.session as AuthSessionContext;
    const claims = session?.getAccessTokenPayload?.();

    let userId: string | undefined;
    try {
      userId = getAppUserId(session);
    } catch {
      return false;
    }

    const requested = request.query?.workspaceId;
    const workspaceIds = [
      ...new Set(
        [claims?.workspaceId, typeof requested === 'string' ? requested : null].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];

    if (!userId || workspaceIds.length === 0) {
      return false;
    }

    for (const workspaceId of workspaceIds) {
      const membership = await this.prisma.usersOnWorkspaces.findUnique({
        where: { userId_workspaceId: { userId, workspaceId } },
        select: { role: true, status: true },
      });

      if (
        membership?.role !== RoleEnum.ADMIN ||
        membership.status !== 'ACTIVE'
      ) {
        return false;
      }
    }

    return true;
  }
}
