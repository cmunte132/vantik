/**
 * A person's teams are one list on their membership, `teamIds`. It used to be
 * read, changed and written back whole, so two changes to one person at once
 * kept only the second: making two teams at once left each admin a member of
 * one of them, and every route scoped to the other answered 404. Each change
 * is now one statement, which Postgres applies to the list as it stands.
 */
import { PrismaService } from 'nestjs-prisma';

import TeamsService from './teams.service';

const WORKSPACE = 'ws-1';

function buildService() {
  const prisma = {
    usersOnWorkspaces: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ userId: 'user-1', role: 'ADMIN', teamIds: [] }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ userId: 'user-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    team: {
      findMany: jest.fn().mockResolvedValue([{ id: 'team-1' }]),
      update: jest.fn().mockResolvedValue({ id: 'team-1' }),
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
  };
}

/** The SQL of a tagged-template call, with its values as `?`. */
function sqlOf(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
}

describe('TeamsService team membership', () => {
  it('adds a team by appending it in the database, only when it is missing', async () => {
    const { service, prisma } = buildService();

    await service.addTeamMember('team-1', WORKSPACE, 'user-1');

    expect(prisma.usersOnWorkspaces.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        workspaceId: WORKSPACE,
        NOT: { teamIds: { has: 'team-1' } },
      },
      data: { teamIds: { push: 'team-1' } },
    });
    expect(prisma.usersOnWorkspaces.update).not.toHaveBeenCalled();
  });

  it('removes one person from a team in one statement', async () => {
    const { service, prisma } = buildService();

    await service.removeTeamMember({ teamId: 'team-1' }, WORKSPACE, {
      userId: 'user-1',
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const call = prisma.$executeRaw.mock.calls[0];
    expect(sqlOf(call)).toContain('array_remove("teamIds", ?)');
    expect(call.slice(1)).toEqual(
      expect.arrayContaining(['team-1', WORKSPACE]),
    );
    expect(prisma.usersOnWorkspaces.update).not.toHaveBeenCalled();
  });

  it('counts only the issues that are not deleted when it deletes a team', async () => {
    const { service, prisma } = buildService();

    await service.deleteTeam({ teamId: 'team-1' }, 'user-1', WORKSPACE);

    expect(prisma.issue.findMany).toHaveBeenCalledWith({
      where: { teamId: 'team-1', deleted: null },
    });
    expect(prisma.team.update).toHaveBeenCalled();
  });

  it('refuses to delete a team that has an issue that is not deleted', async () => {
    const { service, prisma } = buildService();
    prisma.issue.findMany.mockResolvedValue([{ id: 'issue-1' }]);

    await expect(
      service.deleteTeam({ teamId: 'team-1' }, 'user-1', WORKSPACE),
    ).rejects.toThrow('There are issues in this team');
    expect(prisma.team.update).not.toHaveBeenCalled();
  });

  it('removes a deleted team from everyone in its workspace in one statement', async () => {
    const { service, prisma } = buildService();

    await service.deleteTeam({ teamId: 'team-1' }, 'user-1', WORKSPACE);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const call = prisma.$executeRaw.mock.calls[0];
    expect(sqlOf(call)).toContain('array_remove("teamIds", ?)');
    expect(sqlOf(call)).toContain('"workspaceId" = ?');
    expect(call.slice(1)).toEqual(
      expect.arrayContaining(['team-1', WORKSPACE]),
    );
    expect(prisma.usersOnWorkspaces.update).not.toHaveBeenCalled();
  });
});
