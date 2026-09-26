import { BadRequestException, Injectable } from '@nestjs/common';
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
import { assertWorkspaceAdmin } from 'common/workspace-access';

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

    const teamIssues = await this.prisma.issue.findMany({
      where: {
        teamId: teamRequestParams.teamId,
      },
    });

    if (teamIssues.length > 0) {
      throw new BadRequestException(
        'There are issues in this team, remove them before you delete',
      );
    }

    // First, get all users who have this team
    const usersWithTeam = await this.prisma.usersOnWorkspaces.findMany({
      where: {
        teamIds: {
          has: teamRequestParams.teamId,
        },
      },
    });

    // Update each user to remove the team ID
    await Promise.all(
      usersWithTeam.map((user) =>
        this.prisma.usersOnWorkspaces.update({
          where: {
            id: user.id,
          },
          data: {
            teamIds: {
              set: user.teamIds.filter((id) => id !== teamRequestParams.teamId),
            },
          },
        }),
      ),
    );

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
    const existingTeamIds = await this.prisma.usersOnWorkspaces.findUnique({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId,
        },
      },
      select: {
        teamIds: true,
      },
    });

    const updatedTeamIds = existingTeamIds?.teamIds.includes(teamId)
      ? existingTeamIds.teamIds
      : [...(existingTeamIds?.teamIds || []), teamId];

    const membership = await this.prisma.usersOnWorkspaces.update({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId,
        },
      },
      data: { teamIds: updatedTeamIds },
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
    const userOnWorkspace = await this.prisma.usersOnWorkspaces.findUnique({
      where: {
        userId_workspaceId: {
          userId: teamMemberData.userId,
          workspaceId,
        },
      },
    });

    const issues = await this.prisma.issue.findMany({
      where: {
        assigneeId: userOnWorkspace.userId,
        teamId: teamRequestParams.teamId,
      },
    });

    if (issues.length > 0) {
      throw new BadRequestException('There are issues assigned to this user');
    }

    const updatedTeamIds = userOnWorkspace.teamIds.filter(
      (id) => id !== teamRequestParams.teamId,
    );

    const membership = await this.prisma.usersOnWorkspaces.update({
      where: {
        userId_workspaceId: {
          userId: teamMemberData.userId,
          workspaceId,
        },
      },
      data: { teamIds: updatedTeamIds },
      include: { user: true },
    });

    await this.syncGateway.refreshTeamRooms(teamMemberData.userId, workspaceId);

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
