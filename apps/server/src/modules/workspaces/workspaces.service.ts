import { BadRequestException, Injectable } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import {
  InviteStatusEnum,
  RoleEnum,
  UpdateWorkspacePreferencesDto,
  UsersOnWorkspaces,
  Workspace,
  WorkspaceStatusEnum,
} from '@vantikhq/types';
import { Request, Response } from 'express';
import { PrismaService } from 'nestjs-prisma';
import {
  createNewSession,
  SessionContainer,
} from 'supertokens-node/recipe/session';
import Session from 'supertokens-node/recipe/session';

import { createMagicLink } from 'common/utils/login';

import { getAppUserId } from 'modules/auth/session-user';
import { LoggerService } from 'modules/logger/logger.service';
import { workflowSeedData } from 'modules/teams/teams.interface';
import { UsersService } from 'modules/users/users.service';

import {
  CreateInitialResourcesDto,
  CreateWorkspaceInput,
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
  ) {}

  async createInitialResources(
    session: SessionContainer,
    workspaceData: CreateInitialResourcesDto,
    res: Response,
    req: Request,
  ) {
    const userId = getAppUserId(session);
    const workspace = await this.prisma.usersOnWorkspaces.findFirst({
      where: { userId },
    });

    if (workspace) {
      throw new BadRequestException('Already workspace exist');
    }

    await this.prisma.$transaction(
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
            preferences: {
              actionCount: 2,
            },
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

    // Re-issued so the token carries the workspace that did not exist when the
    // session was minted. It has to name the *recipe* user — the credential
    // this session was created from — because that is what createNewSession
    // resolves an account from. Handing it the account id instead left every
    // first-run install unable to finish onboarding.
    await Session.createNewSession(
      req,
      res,
      'public',
      session.getRecipeUserId(),
    );

    res.send({ status: 200, message: 'success' });
  }

  async createWorkspace(
    userId: string,
    workspaceData: CreateWorkspaceInput,
  ): Promise<Workspace> {
    const workspace = await this.prisma.workspace.create({
      data: {
        ...workspaceData,
        usersOnWorkspaces: {
          create: { userId },
        },
        label: { create: labelSeedData },
      },
      include: {
        usersOnWorkspaces: true,
      },
    });

    return workspace;
  }

  async getWorkspaceByName(name: string): Promise<Workspace> {
    return await this.prisma.workspace.findFirst({
      where: {
        name: {
          equals: name,
          mode: 'insensitive',
        },
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

  async getWorkspaceBySlug(slug: string): Promise<Workspace> {
    return await this.prisma.workspace.findFirst({
      where: {
        name: {
          equals: slug,
          mode: 'insensitive',
        },
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
    return await this.prisma.workspace.update({
      data: workspaceData,
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

    await this.prisma.workspace.update({
      where: {
        id: workspaceId,
      },
      data: {
        preferences: {
          ...(workspace.preferences as Record<string, string | boolean>),
          ...workspaceData,
        },
      },
    });

    return workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<Workspace> {
    return await this.prisma.workspace.delete({
      where: {
        id: workspaceId,
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
    session: SessionContainer,
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

        const magicLink = await createMagicLink(email);

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

  async getInvites(workspaceId: string) {
    // Only the ones still outstanding. `deleted` is what closes an invite;
    // filtering on status alone worked only while a decline was miswritten as
    // an acceptance, and would have listed declined invites as pending the
    // moment that was fixed.
    return await this.prisma.invite.findMany({
      where: {
        workspaceId,
        deleted: null,
        status: { not: InviteStatusEnum.ACCEPTED },
      },
    });
  }

  async inviteAction(
    req: Request,
    res: Response,
    inviteId: string,
    session: SessionContainer,
    accepted: boolean = false,
  ) {
    const userId = getAppUserId(session);

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

    // Same reason as onboarding: the token has to pick up the workspace the
    // invite just joined, and it is minted from the recipe user, not the
    // account.
    await createNewSession(req, res, 'public', session.getRecipeUserId());
    res.status(200).json(invite);
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
