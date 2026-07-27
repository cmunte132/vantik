/**
 * Who may provision, see and revoke an agent.
 *
 * Personal ownership and admin-gating are contradictory, and before this the
 * gate won — so the feature was unavailable to most of the people it was built
 * for. Splitting `resolveAdminWorkspaceId` into "resolve the workspace" and
 * "assert admin" is what fixes that, and it is easy to fix it too far: the
 * half that must survive is that a workspace-owned agent still requires admin.
 */
import { ForbiddenException } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import {
  assertWorkspaceAdmin,
  resolveMemberWorkspaceId,
} from 'common/workspace-access';

const WORKSPACE = 'workspace-1';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';

function buildPrisma() {
  return {
    usersOnWorkspaces: {
      findUnique: jest.fn(({ where }) => {
        const userId = where.userId_workspaceId.userId;
        if (where.userId_workspaceId.workspaceId !== WORKSPACE) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          userId === ADMIN
            ? { status: 'ACTIVE', role: RoleEnum.ADMIN }
            : userId === MEMBER
              ? { status: 'ACTIVE', role: RoleEnum.USER }
              : null,
        );
      }),
    },
  } as unknown as PrismaService;
}

describe('workspace resolution is separable from the admin assertion', () => {
  it('resolves a workspace for an ordinary member', async () => {
    // The whole point: a member can reach workspace resolution without
    // inheriting an admin gate.
    await expect(
      resolveMemberWorkspaceId(buildPrisma(), MEMBER, WORKSPACE),
    ).resolves.toBe(WORKSPACE);
  });

  it('still refuses someone who is not a member at all', async () => {
    await expect(
      resolveMemberWorkspaceId(buildPrisma(), 'user-stranger', WORKSPACE),
    ).rejects.toThrow(/do not have access/);
  });

  it('asserts admin separately, and refuses a member', async () => {
    await expect(
      assertWorkspaceAdmin(buildPrisma(), MEMBER, WORKSPACE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an admin through the assertion', async () => {
    await expect(
      assertWorkspaceAdmin(buildPrisma(), ADMIN, WORKSPACE),
    ).resolves.toBeUndefined();
  });

  it('reads the role from the membership, not the session workspace', async () => {
    // Someone who administers another workspace but is only a member here must
    // not pass while acting on this one.
    const prisma = {
      usersOnWorkspaces: {
        findUnique: jest.fn(() =>
          Promise.resolve({ status: 'ACTIVE', role: RoleEnum.USER }),
        ),
      },
    } as unknown as PrismaService;

    await expect(
      assertWorkspaceAdmin(prisma, ADMIN, 'workspace-other'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
