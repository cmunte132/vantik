/**
 * The team boundary on the routes that serve the team object itself.
 *
 * ENG-79 made a team a visibility boundary and held it where issue content is
 * served. The `/v1/teams` routes were left behind: they sat on `AuthGuard`
 * alone, so a member of one team could read the name, the identifier, the
 * preferences and the full roster of every other team in the workspace.
 *
 * The rule these tests pin, recorded in `common/team-access.ts`:
 *
 * - A member reads their own teams.
 * - An **admin reads every team by role**, because `createTeam` only adds the
 *   admins who existed when the team was made — so membership alone would take
 *   the team management screen away from an admin who predates a team.
 * - The role widens the *roster* and never the *content*. `visibleTeamIds`,
 *   which governs issues, is untouched by any of this.
 */
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import TeamsService from './teams.service';

const WORKSPACE = 'ws-1';
const MY_TEAM = 'team-mine';
const OTHER_TEAM = 'team-theirs';

function buildService(role: 'ADMIN' | 'USER', teamIds: string[] = [MY_TEAM]) {
  const prisma = {
    usersOnWorkspaces: {
      findUnique: jest.fn().mockResolvedValue({ role, teamIds }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    team: {
      // Every team in the workspace, which is what an admin's read resolves to.
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: MY_TEAM }, { id: OTHER_TEAM }]),
      findUnique: jest.fn().mockResolvedValue({ id: MY_TEAM }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService;

  return { service: new TeamsService(prisma, null), prisma };
}

describe('TeamsService read boundary', () => {
  describe('a member', () => {
    it('lists only their own teams', async () => {
      const { service, prisma } = buildService('USER', [MY_TEAM]);
      await service.getTeams(WORKSPACE, 'user-1');

      expect(prisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: WORKSPACE,
            id: { in: [MY_TEAM] },
          }),
        }),
      );
    });

    it('cannot read another team by id', async () => {
      const { service } = buildService('USER', [MY_TEAM]);

      await expect(
        service.getTeam({ teamId: OTHER_TEAM }, 'user-1', WORKSPACE),
      ).rejects.toThrow(NotFoundException);
    });

    it('cannot read another team’s roster', async () => {
      const { service } = buildService('USER', [MY_TEAM]);

      await expect(
        service.getTeamMembers({ teamId: OTHER_TEAM }, 'user-1', WORKSPACE),
      ).rejects.toThrow(NotFoundException);
    });

    it('cannot find another team by name', async () => {
      // Filtered in the query rather than checked after, so an unreadable name
      // and an imaginary one give the same answer — otherwise this route
      // enumerates the other teams' names.
      const { service, prisma } = buildService('USER', [MY_TEAM]);
      await service.getTeamByName(WORKSPACE, 'Their Team', 'user-1');

      expect(prisma.team.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: [MY_TEAM] } }),
        }),
      );
    });

    it('reads its own team fine', async () => {
      const { service } = buildService('USER', [MY_TEAM]);

      await expect(
        service.getTeam({ teamId: MY_TEAM }, 'user-1', WORKSPACE),
      ).resolves.toBeTruthy();
    });

    it('with no team reads no team', async () => {
      const { service } = buildService('USER', []);

      await expect(
        service.getTeam({ teamId: MY_TEAM }, 'user-1', WORKSPACE),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('an admin', () => {
    it('reads every team by role, not by membership', async () => {
      // The case the whole decision exists for: an admin who predates a team
      // is not in it, and must still be able to administer it.
      const { service } = buildService('ADMIN', []);

      await expect(
        service.getTeam({ teamId: OTHER_TEAM }, 'admin-1', WORKSPACE),
      ).resolves.toBeTruthy();
    });

    it('reads every team’s roster', async () => {
      const { service } = buildService('ADMIN', []);

      await expect(
        service.getTeamMembers({ teamId: OTHER_TEAM }, 'admin-1', WORKSPACE),
      ).resolves.toEqual([]);
    });

    it('pins the workspace on a roster read, so a shared team id cannot cross one', async () => {
      const { service, prisma } = buildService('ADMIN', []);
      await service.getTeamMembers({ teamId: MY_TEAM }, 'admin-1', WORKSPACE);

      expect(prisma.usersOnWorkspaces.findMany).toHaveBeenCalledWith({
        where: { workspaceId: WORKSPACE, teamIds: { has: MY_TEAM } },
        include: { user: true },
      });
    });
  });

  it('gives a non-member of the workspace nothing', async () => {
    const prisma = {
      usersOnWorkspaces: { findUnique: jest.fn().mockResolvedValue(null) },
      team: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new TeamsService(prisma, null);

    await expect(
      service.getTeam({ teamId: MY_TEAM }, 'stranger', WORKSPACE),
    ).rejects.toThrow(NotFoundException);
  });
});
