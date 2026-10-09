import { ExecutionContext } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { createAuthSessionContext } from 'modules/auth/auth.interface';

import { AdminGuard } from './admin.guard';

/**
 * Two people in two workspaces. The access token names one workspace and the
 * role there, so a guard that reads the token judges the other one wrongly.
 */
const MEMBERSHIPS: Record<string, { role: string; status: string }> = {
  'user-1:ws-first': { role: 'ADMIN', status: 'ACTIVE' },
  'user-1:ws-second': { role: 'USER', status: 'ACTIVE' },
  'user-2:ws-first': { role: 'USER', status: 'ACTIVE' },
  'user-2:ws-second': { role: 'ADMIN', status: 'ACTIVE' },
};

function guard() {
  const prisma = {
    usersOnWorkspaces: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { userId_workspaceId: { userId: string; workspaceId: string } };
        }) =>
          MEMBERSHIPS[
            `${where.userId_workspaceId.userId}:${where.userId_workspaceId.workspaceId}`
          ] ?? null,
      ),
    },
  };

  return new AdminGuard(prisma as unknown as PrismaService);
}

function context(
  userId: string,
  tokenWorkspace: string,
  tokenRole: string,
  query: Record<string, string> = {},
) {
  const session = createAuthSessionContext({
    appUserId: userId,
    workspaceId: tokenWorkspace,
    role: tokenRole,
  });

  return {
    switchToHttp: () => ({ getRequest: () => ({ session, query }) }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard for a user with several workspaces', () => {
  it('lets an admin of the session workspace through', async () => {
    expect(
      await guard().canActivate(context('user-1', 'ws-first', 'ADMIN')),
    ).toBe(true);
  });

  it('refuses a plain member of the requested workspace although the token says ADMIN', async () => {
    const ctx = context('user-1', 'ws-first', 'ADMIN', {
      workspaceId: 'ws-second',
    });

    expect(await guard().canActivate(ctx)).toBe(false);
  });

  it('refuses an admin of the requested workspace who is only a member of the session one', async () => {
    const ctx = context('user-2', 'ws-first', 'USER', {
      workspaceId: 'ws-second',
    });

    // The handler writes to the session workspace, where they are no admin.
    expect(await guard().canActivate(ctx)).toBe(false);
  });

  it('refuses an ADMIN claim in the token when the membership says otherwise', async () => {
    expect(
      await guard().canActivate(context('user-2', 'ws-first', 'ADMIN')),
    ).toBe(false);
  });

  it('refuses a caller with no membership in the workspace', async () => {
    expect(
      await guard().canActivate(context('user-3', 'ws-first', 'ADMIN')),
    ).toBe(false);
  });
});
