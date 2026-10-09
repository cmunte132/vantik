import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateTeamDto,
  RoleEnum,
  Team,
  UpdateTeamDto,
  UpdateTeamPreferencesDto,
  UsersOnWorkspaces,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { assertTeamsVisible, readableTeamIds } from 'common/team-access';
import {
  assertTeamInWorkspace,
  assertWorkspaceAdmin,
} from 'common/workspace-access';

import { SyncGateway } from 'modules/sync/sync.gateway';
import { UserIdParams } from 'modules/users/users.interface';

import {
  supportWorkflowSeedData,
  TeamRequestParams,
  workflowSeedData,
} from './teams.interface';

@Injectable()
export default class TeamsService {
  constructor(
    private prisma: PrismaService,
    private syncGateway: SyncGateway,
  ) {}

  /**
   * The teams of this workspace the caller may read: their own, or every one
   * of them for an admin. See `readableTeamIds` for why the role widens this
   * and never widens what issues they can see.
   */
  async getTeams(workspaceId: string, userId: string): Promise<Team[]> {
    const readable = await readableTeamIds(this.prisma, userId, workspaceId);

    return await this.prisma.team.findMany({
      where: {
        workspaceId,
        deleted: null,
        id: { in: readable },
      },
      include: {
        workspace: true,
      },
    });
  }

  async createTeam(
    workspaceId: string,
    userId: string,
    { preferences, ...teamData }: CreateTeamDto,
  ): Promise<Team> {
    const team = await this.prisma.team.create({
      data: {
        workspaceId,
        ...teamData,
        workflow: {
          create:
            preferences?.teamType === 'support'
              ? supportWorkflowSeedData
              : workflowSeedData,
        },
        preferences: {
          ...preferences,
        },
      },
    });

    const botAdminUsers = await this.prisma.usersOnWorkspaces.findMany({
      where: {
        workspaceId,
        OR: [{ role: RoleEnum.BOT }, { role: RoleEnum.ADMIN }],
      },
      select: { userId: true },
    });

    const userIds = botAdminUsers.map(({ userId }) => userId);

    userIds.push(userId);

    await Promise.all(
      userIds.map(async (userId: string) => {
        await this.addTeamMember(team.id, workspaceId, userId);
      }),
    );

    return team;
  }

  /**
   * Update, preferences and delete took the team id on trust behind AuthGuard
   * alone, so any signed-in caller could rename, reconfigure or delete a team
   * in any workspace. They now make the same check `getTeam` does.
   *
   * The fields are copied one by one because the global ValidationPipe keeps
   * keys the DTO does not declare, and a `workspaceId` in the body would have
   * moved the team into another workspace.
   */
  async updateTeam(
    teamRequestParams: TeamRequestParams,
    teamData: UpdateTeamDto,
    userId: string,
    workspaceId: string,
  ): Promise<Team> {
    await this.assertReadable(teamRequestParams.teamId, userId, workspaceId);
    await assertTeamInWorkspace(
      this.prisma,
      teamRequestParams.teamId,
      workspaceId,
    );

    return await this.prisma.team.update({
      data: {
        name: teamData.name,
        identifier: teamData.identifier,
        icon: teamData.icon,
      },
      where: {
        id: teamRequestParams.teamId,
      },
    });
  }

  async updateTeamPreferences(
    teamRequestParams: TeamRequestParams,
    preferencesDto: UpdateTeamPreferencesDto,
    userId: string,
    workspaceId: string,
  ): Promise<Team> {
    await this.assertReadable(teamRequestParams.teamId, userId, workspaceId);
    await assertTeamInWorkspace(
      this.prisma,
      teamRequestParams.teamId,
      workspaceId,
    );

    const team = await this.prisma.team.findUniqueOrThrow({
      where: {
        id: teamRequestParams.teamId,
      },
    });

    // The updated row, not the one read a moment ago. Callers use the response
    // to refresh what they show, and returning the pre-merge team meant a
    // settings form snapped back to the old value until a sync arrived.
    return await this.prisma.team.update({
      where: {
        id: team.id,
      },
      data: {
        preferences: {
          ...(team.preferences as Record<string, string | number | boolean>),
          ...preferencesDto,
        },
      },
    });
  }

  /**
   * Deleting a team is a workspace admin's call, where renaming it is not.
   *
   * Readability is checked first, so a team in another workspace is still
   * not-found rather than forbidden. The role is read from the membership row
   * for this workspace, not from the access token, which carries the role in
   * the caller's first workspace only.
   */
  async deleteTeam(
    teamRequestParams: TeamRequestParams,
    userId: string,
    workspaceId: string,
  ): Promise<Team> {
    await this.assertReadable(teamRequestParams.teamId, userId, workspaceId);
    await assertWorkspaceAdmin(this.prisma, userId, workspaceId);

    // A deleted issue keeps its row. It must not stop the delete, because the
    // webapp does not count it and offers the delete.
    const teamIssues = await this.prisma.issue.findMany({
      where: {
        teamId: teamRequestParams.teamId,
        deleted: null,
      },
    });

    if (teamIssues.length > 0) {
      throw new BadRequestException(
        'There are issues in this team, remove them before you delete',
      );
    }

    await this.removeFromTeamIds(teamRequestParams.teamId, { workspaceId });

    return await this.prisma.team.update({
      where: {
        id: teamRequestParams.teamId,
      },
      data: {
        deleted: new Date().toISOString(),
      },
    });
  }

  /**
   * This method puts one person in one team.
   *
   * A team is a visibility boundary (ENG-79), so this changes what the person
   * may read. `refreshTeamRooms` carries that to any browser the person has
   * open: the socket joins the new team's room, and the client reads again from
   * the start. A delta alone cannot do it — the records of the new team sit
   * below the sequence id the client already holds, so no delta will name them.
   */
  async addTeamMember(
    teamId: string,
    workspaceId: string,
    userId: string,
  ): Promise<UsersOnWorkspaces> {
    await assertTeamInWorkspace(this.prisma, teamId, workspaceId);
    await this.assertMember(userId, workspaceId);

    // Appended by the database, and only when missing. The list used to be
    // read, added to and written back, so of two teams added to one person at
    // once, the second write dropped the first. Making two teams at once does
    // that to every admin, who is then no member of a team they just made.
    await this.prisma.usersOnWorkspaces.updateMany({
      where: { userId, workspaceId, NOT: { teamIds: { has: teamId } } },
      data: { teamIds: { push: teamId } },
    });

    const membership = await this.prisma.usersOnWorkspaces.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId,
        },
      },
      include: { user: true },
    });

    await this.syncGateway.refreshTeamRooms(userId, workspaceId);

    return membership;
  }

  /**
   * The roster of one team, if the caller may read that team.
   *
   * The workspace is pinned as well as the team. A bare `has` on a team id is
   * workspace-agnostic, so it would return memberships from another workspace
   * if two ever shared a team id.
   */
  async getTeamMembers(
    teamRequestParams: TeamRequestParams,
    userId: string,
    workspaceId: string,
  ): Promise<UsersOnWorkspaces[]> {
    await this.assertReadable(teamRequestParams.teamId, userId, workspaceId);

    return await this.prisma.usersOnWorkspaces.findMany({
      where: { workspaceId, teamIds: { has: teamRequestParams.teamId } },
      include: { user: true },
    });
  }

  /**
   * This method takes one person out of one team.
   *
   * The refresh matters more here than when a person joins. An open socket that
   * nobody removes from the room goes on receiving the work of a team the
   * person has left, and the records already in that client's store stay there
   * until it reads again from the start.
   */
  async removeTeamMember(
    teamRequestParams: TeamRequestParams,
    workspaceId: string,
    teamMemberData: UserIdParams,
  ): Promise<UsersOnWorkspaces> {
    await assertTeamInWorkspace(
      this.prisma,
      teamRequestParams.teamId,
      workspaceId,
    );
    const userOnWorkspace = await this.assertMember(
      teamMemberData.userId,
      workspaceId,
    );

    const issues = await this.prisma.issue.findMany({
      where: {
        assigneeId: userOnWorkspace.userId,
        teamId: teamRequestParams.teamId,
      },
    });

    if (issues.length > 0) {
      throw new BadRequestException('There are issues assigned to this user');
    }

    await this.removeFromTeamIds(teamRequestParams.teamId, {
      workspaceId,
      userId: teamMemberData.userId,
    });

    const membership = await this.prisma.usersOnWorkspaces.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: teamMemberData.userId,
          workspaceId,
        },
      },
      include: { user: true },
    });

    await this.syncGateway.refreshTeamRooms(teamMemberData.userId, workspaceId);

    return membership;
  }

  /**
   * Takes a team out of the memberships in a workspace, or out of one person's.
   *
   * In one statement, so that a team added to the same person meanwhile is
   * kept: reading the list and writing it back would drop it. Prisma has no
   * atomic removal from a list, so this is SQL, and it stamps `updatedAt`
   * itself because only Prisma's own writes do that.
   */
  private async removeFromTeamIds(
    teamId: string,
    where: { workspaceId: string; userId?: string },
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "UsersOnWorkspaces"
      SET "teamIds" = array_remove("teamIds", ${teamId}), "updatedAt" = now()
      WHERE "workspaceId" = ${where.workspaceId}
        AND ${teamId} = ANY("teamIds")
        ${where.userId ? Prisma.sql`AND "userId" = ${where.userId}` : Prisma.empty}
    `;
  }

  /**
   * The membership of one person in this workspace. A person who is not in it
   * is not found; the lookup used to throw Prisma's P2025, which is a 500.
   */
  private async assertMember(userId: string, workspaceId: string) {
    const membership = await this.prisma.usersOnWorkspaces.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });

    if (!membership) {
      throw new NotFoundException({ message: `User ${userId} not found` });
    }

    return membership;
  }

  /**
   * Proves the caller may act on this team's own record: it is in their
   * workspace, and they are in the team or administer the workspace. See
   * `readableTeamIds` for why the role widens this and nothing else.
   */
  private async assertReadable(
    teamId: string,
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const readable = await readableTeamIds(this.prisma, userId, workspaceId);
    await assertTeamsVisible([teamId], readable);
  }
}
