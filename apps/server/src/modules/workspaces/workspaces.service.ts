import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { Prisma } from '@prisma/client';
import {
  InviteStatusEnum,
  RoleEnum,
  UpdateWorkspacePreferencesDto,
  UsersOnWorkspaces,
  Workspace,
  WorkspaceStatusEnum,
} from '@vantikhq/types';
import { Response } from 'express';
import { PrismaService } from 'nestjs-prisma';
import { AuthSessionContext } from 'modules/auth/auth.interface';
import { AuthService } from 'modules/auth/auth.service';

import { getAppUserId } from 'modules/auth/session-user';
import { LoggerService } from 'modules/logger/logger.service';
import { workflowSeedData } from 'modules/teams/teams.interface';
import { UsersService } from 'modules/users/users.service';

import {
  CreateInitialResourcesDto,
  InviteUsersBody,
  UpdateWorkspaceInput,
  UserWorkspaceOtherData,
  labelSeedData,
  promptsSeedData,
} from './workspaces.interface';

@Injectable()
export default class WorkspacesService {
  private readonly logger: LoggerService = new LoggerService(
    'WorkspaceService',
  );
  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService,
    private usersService: UsersService,
    private authService: AuthService,
  ) {}

  async createInitialResources(
    session: AuthSessionContext,
    workspaceData: CreateInitialResourcesDto,
    res: Response,
  ) {
    const userId = getAppUserId(session);
    const workspace = await this.prisma.usersOnWorkspaces.findFirst({
      where: { userId },
    });

    if (workspace) {
      throw new BadRequestException('Already workspace exist');
    }

    const created = await this.prisma.$transaction(
      async (prisma) => {
        await prisma.user.update({
          where: { id: userId },
          data: {
            fullname: workspaceData.fullname,
          },
        });

        const workspace = await prisma.workspace.create({
          data: {
            name: workspaceData.workspaceName,
            slug: workspaceData.workspaceName
              .toLowerCase()
              .replace(/[^a-z0-9]/g, ''),
            usersOnWorkspaces: {
              create: { userId },
            },
            team: {
              create: {
                name: workspaceData.teamName,
                identifier: workspaceData.teamIdentifier,
                workflow: { create: workflowSeedData },
              },
            },
            label: { create: labelSeedData },
            prompts: {
              createMany: {
                data: promptsSeedData,
                skipDuplicates: true,
              },
            },
          },
          include: {
            team: true,
            usersOnWorkspaces: true,
          },
        });

        await prisma.usersOnWorkspaces.update({
          where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
          data: { teamIds: [workspace.team[0].id] },
        });

        return workspace;
      },
      {
        maxWait: 20000,
        timeout: 60000,
      },
    );

    await this.moveSessionTo(session, created.id, RoleEnum.ADMIN);
    res.send({ status: 200, message: 'success' });
  }

  async getAllWorkspaces(userId: string): Promise<Workspace[]> {
    return await this.prisma.workspace.findMany({
      where: {
        // `some`, not `every`. `every` asks that *all* of a workspace's
        // memberships belong to this user, so the moment a second person joins
        // the workspace stops being returned at all — and an empty list reads
        // as "you have no workspaces" rather than as a bug.
        usersOnWorkspaces: { some: { userId } },
      },
    });
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    return await this.prisma.workspace.findUnique({
      where: {
        id: workspaceId,
      },
      include: {
        usersOnWorkspaces: {
          include: {
            user: true,
          },
        },
      },
    });
  }

  async updateWorkspace(
    workspaceId: string,
    workspaceData: UpdateWorkspaceInput,
  ): Promise<Workspace> {
    // Named, not passed through: the body keeps keys the input does not
    // declare, and any member may call this. Preferences, which hold the
    // workspace's knowledge triage settings, are changed only through the
    // admin route.
    return await this.prisma.workspace.update({
      data: { name: workspaceData.name, icon: workspaceData.icon },
      where: {
        id: workspaceId,
      },
    });
  }

  async updateWorkspacePreferences(
    workspaceId: string,
    workspaceData: UpdateWorkspacePreferencesDto,
  ): Promise<Workspace> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: {
        id: workspaceId,
      },
    });

    return await this.prisma.workspace.update({
      where: {
        id: workspaceId,
      },
      data: {
        preferences: {
          ...(workspace.preferences as Prisma.InputJsonObject),
          ...workspaceData,
        } as Prisma.InputJsonObject,
      },
    });
  }

  async addUserToWorkspace(
    workspaceId: string,
    userId: string,
    otherData?: UserWorkspaceOtherData,
  ): Promise<UsersOnWorkspaces> {
    return await this.prisma.usersOnWorkspaces.upsert({
      where: {
        userId_workspaceId: { workspaceId, userId },
      },
      update: { ...otherData },
      create: { workspaceId, userId, ...otherData },
    });
  }

  async inviteUsers(
    session: AuthSessionContext,
    workspaceId: string,
    inviteUsersBody: InviteUsersBody,
  ): Promise<Record<string, string>> {
    const { emailIds, teamIds, role } = inviteUsersBody;
    const workspace = await this.getWorkspace(workspaceId);
    const iniviter = await this.usersService.getUser(getAppUserId(session));

    const emails = emailIds.split(',');
    const responseRecord: Record<string, string> = {};

    for (const e of emails) {
      const email = e.trim();
      try {
        await this.prisma.invite.upsert({
          where: {
            emailId_workspaceId: {
              emailId: email,
              workspaceId,
            },
          },
          create: {
            emailId: email,
            fullName: email.split('@')[0],
            workspaceId,
            sentAt: new Date().toISOString(),
            expiresAt: new Date(),
            status: InviteStatusEnum.INVITED,
            teamIds,
            role,
          },
          update: {
            sentAt: new Date().toISOString(),
          },
        });

        const magicLink = await this.authService.createInviteMagicLink(email);

        await this.mailerService.sendMail({
          to: email,
          subject: `Invite to ${workspace.name}`,
          template: 'inviteUser',
          context: {
            workspaceName: workspace.name,
            inviterName: iniviter.fullname,
            invitationUrl: magicLink,
          },
        });
        this.logger.info({
          message: 'Invite Email sent to user',
          where: `WorkspacesService.inviteUsers`,
        });

        responseRecord[email] = 'Success';
      } catch (error) {
        responseRecord[email] = error;
      }
    }

    return responseRecord;
  }

  async inviteAction(
    res: Response,
    inviteId: string,
    session: AuthSessionContext,
    accepted: boolean = false,
  ) {
    const userId = getAppUserId(session);

    // Only an open invite, and only by the person it was sent to. This took
    // any invite id from anyone signed in, so whoever had one joined that
    // workspace in the role it carried, and a declined invite could still be
    // accepted afterwards.
    const { email } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    const open = await this.prisma.invite.findFirst({
      where: { id: inviteId, emailId: email, deleted: null },
    });
    if (!open) {
      throw new NotFoundException(`Invite ${inviteId} not found`);
    }

    if (accepted) {
      const invite = await this.prisma.invite.update({
        where: { id: inviteId },
        data: { status: InviteStatusEnum.ACCEPTED },
      });

      await this.addUserToWorkspace(invite.workspaceId, userId, {
        teamIds: invite.teamIds,
        joinedAt: new Date().toISOString(),
        role: invite.role as RoleEnum,
        status: WorkspaceStatusEnum.ACTIVE,
      });
    }

    // Closes the invite either way, but records which way: this used to write
    // ACCEPTED unconditionally, so someone who pressed Decline was left on the
    // record as having joined.
    const invite = await this.prisma.invite.update({
      where: { id: inviteId },
      data: {
        status: accepted
          ? InviteStatusEnum.ACCEPTED
          : InviteStatusEnum.DECLINED,
        deleted: new Date().toISOString(),
      },
    });

    if (accepted) {
      await this.moveSessionTo(session, invite.workspaceId, invite.role);
    }
    res.status(200).json(invite);
  }

  /**
   * Points the browser session of the request at the workspace. A PAT has a
   * fixed workspace and no session row, so nothing changes for it.
   */
  private async moveSessionTo(
    session: AuthSessionContext,
    workspaceId: string,
    role: string,
  ) {
    const { sessionId } = session.getAccessTokenPayload();
    if (sessionId) {
      await this.authService.updateSessionWorkspace(sessionId, workspaceId, role);
    }
  }

  async suspendUser(workspaceId: string, userId: string) {
    const userOnWorkspace =
      await this.prisma.usersOnWorkspaces.findUniqueOrThrow({
        where: {
          userId_workspaceId: {
            workspaceId,
            userId,
          },
        },
      });

    await this.prisma.usersOnWorkspaces.update({
      where: {
        id: userOnWorkspace.id,
      },
      data: {
        status: 'SUSPENDED',
      },
    });
  }
}
