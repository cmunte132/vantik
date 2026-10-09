/**
 * Adding or removing a team member names a team by id in the path. The route is
 * behind AdminGuard, which proves the caller administers a workspace, and says
 * nothing about the team. So the service must prove the team is in that
 * workspace, or an admin of workspace A could write a team of workspace B into
 * a membership.
 */
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import TeamsService from './teams.service';

const WORKSPACE_A = 'ws-a';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';

function buildService() {
  const prisma = {
    usersOnWorkspaces: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { userId_workspaceId: { userId: string } };
        }) =>
          where.userId_workspaceId.userId === 'user-a'
            ? { userId: 'user-a', teamIds: [] as string[] }
            : null,
      ),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ userId: 'user-a' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    team: {
      // Only team A is in workspace A, as the real `where` would find it.
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; workspaceId: string } }) =>
          where.id === TEAM_A && where.workspaceId === WORKSPACE_A
            ? { id: TEAM_A }
            : null,
      ),
    },
    issue: { findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const syncGateway = { refreshTeamRooms: jest.fn() };

  return {
    service: new TeamsService(
      prisma as unknown as PrismaService,
      syncGateway as never,
    ),
    prisma,
    syncGateway,
  };
}

describe('TeamsService member routes across workspaces', () => {
  it('refuses to add a member to a team in another workspace', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.addTeamMember(TEAM_B, WORKSPACE_A, 'user-a'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.usersOnWorkspaces.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to remove a member from a team in another workspace', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.removeTeamMember({ teamId: TEAM_B }, WORKSPACE_A, {
        userId: 'user-a',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('adds a member to a team in the same workspace', async () => {
    const { service, prisma } = buildService();

    await service.addTeamMember(TEAM_A, WORKSPACE_A, 'user-a');

    expect(prisma.usersOnWorkspaces.updateMany).toHaveBeenCalled();
  });

  it('answers 404 when the user to add is unknown', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.addTeamMember(TEAM_A, WORKSPACE_A, 'nobody'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.usersOnWorkspaces.updateMany).not.toHaveBeenCalled();
  });

  it('answers 404 when the user to remove is unknown', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.removeTeamMember({ teamId: TEAM_A }, WORKSPACE_A, {
        userId: 'nobody',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
