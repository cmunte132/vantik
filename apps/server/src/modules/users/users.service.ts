import { randomBytes } from 'crypto';

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AgentAccount,
  AgentOwnership,
  AgentScope,
  AgentSummary,
  CodeDtoWithWorkspace,
  DEFAULT_AGENT_SCOPES,
  GetUsersDto,
  PublicUser,
  RoleEnum,
  User,
  UserTypeEnum,
} from '@vantikhq/types';
import { Response } from 'express';
import { PrismaService } from 'nestjs-prisma';
import supertokens from 'supertokens-node';
import Passwordless from 'supertokens-node/recipe/passwordless';
import Session from 'supertokens-node/recipe/session';

import { generatePersonalAccessToken } from 'common/authentication';
import { PatPrincipal, resolvePatPrincipal } from 'common/pat-session';

import { agentSettings } from 'modules/auth/agent-scope';
import { LoggerService } from 'modules/logger/logger.service';

import {
  UpdateUserBody,
  userSerializer,
  UserWithInvites,
} from './users.interface';
import { generateUniqueId } from './users.utils';

@Injectable()
export class UsersService {
  private readonly logger = new LoggerService(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * Records a way in to an account, creating the account if this is the first
   * one.
   *
   * `supertokensUserId` is a credential, not an identity: the same person
   * signing in with a login code and a passkey arrives with two of them. The
   * account is keyed on email, which is what makes the second credential
   * attach to the existing person instead of inventing a new one.
   */
  async upsertUserForIdentity(
    supertokensUserId: string,
    provider: string,
    email: string,
    fullname: string,
    username?: string,
  ) {
    try {
      const user = await this.prisma.user.upsert({
        where: { email },
        create: {
          email,
          fullname,
          username: username ?? email.split('@')[0],
        },
        update: {},
      });

      await this.prisma.authIdentity.upsert({
        where: { supertokensUserId },
        create: { userId: user.id, provider, supertokensUserId },
        update: {},
      });

      return user;
    } catch (error) {
      this.logger.error({
        message: `Error while upserting the user for identity: ${supertokensUserId}`,
        where: `UsersService.upsertUserForIdentity`,
        error,
      });
      throw new InternalServerErrorException(
        error,
        `Error while upserting the user for identity: ${supertokensUserId}`,
      );
    }
  }

  /**
   * The account a SuperTokens session belongs to.
   *
   * Sessions carry a recipe user id, which is not an account id and has not
   * been one since identity moved into this database.
   */
  async getUserIdForSupertokensId(
    supertokensUserId: string,
  ): Promise<string | null> {
    const identity = await this.prisma.authIdentity.findUnique({
      where: { supertokensUserId },
      select: { userId: true },
    });

    return identity ? identity.userId : null;
  }

  async upsertUser(
    id: string,
    email: string,
    fullname: string,
    username?: string,
  ) {
    try {
      return await this.prisma.user.upsert({
        where: { email },
        create: {
          id,
          email,
          fullname,
          username: username ?? email.split('@')[0],
        },
        update: {},
      });
    } catch (error) {
      this.logger.error({
        message: `Error while upserting the user with id: ${id}`,
        where: `UsersService.upsertUser`,
        error,
      });
      throw new InternalServerErrorException(
        error,
        `Error while upserting the user with id: ${id}`,
      );
    }
  }

  async getUser(id: string): Promise<UserWithInvites> {
    this.logger.debug({
      message: `fetching user with id ${id}`,
      payload: { id },
      where: `UsersService.getUser`,
    });

    const user = await this.prisma.user.findUnique({
      where: {
        id,
      },
      include: {
        usersOnWorkspaces: {
          include: {
            workspace: true,
          },
        },
      },
    });

    const invites = await this.getInvitesForUser(user.email);
    const serializeUser = userSerializer(user);
    return { ...serializeUser, invites };
  }

  async getUsersbyId(
    getUsersDto: GetUsersDto,
    workspaceId: string,
  ): Promise<PublicUser[]> {
    const where: Prisma.UserWhereInput = {
      id: { in: getUsersDto.userIds },
    };

    if (workspaceId) {
      where.usersOnWorkspaces = {
        some: { workspaceId },
      };
    }

    const users = await this.prisma.user.findMany({
      where,
      include: {
        usersOnWorkspaces: true,
      },
    });

    return users.map((user) => ({
      id: user.id,
      username: user.username,
      fullname: user.fullname,
      email: user.email,
      image: user.image,
      // This default takes the first workspace
      role: user.usersOnWorkspaces[0].role,
      // Not workspace-scoped like role: it says whether this is a person at
      // all, which is what the UI badges on.
      type: user.type,
    }));
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({
      where: {
        email,
      },
      include: {
        usersOnWorkspaces: {
          include: {
            workspace: true,
          },
        },
      },
    });

    // An unknown address is an answer, not a fault. The serializer reads
    // straight through the record, so handing it a miss threw a TypeError and
    // made "is this email taken" impossible to ask.
    return user ? userSerializer(user) : null;
  }
  async updateUser(id: string, updateData: UpdateUserBody) {
    const user = await this.prisma.user.update({
      where: {
        id,
      },
      data: {
        ...updateData,
      },
      include: {
        usersOnWorkspaces: {
          include: {
            workspace: true,
          },
        },
      },
    });
    return userSerializer(user);
  }

  async checkifAdmin(userId: string, workspaceId: string) {
    try {
      const userOnWorkspace = await this.prisma.usersOnWorkspaces.findFirst({
        where: {
          userId,
          workspaceId,
        },
      });

      if (!userOnWorkspace) {
        throw new NotFoundException('User not found in workspace');
      }

      return userOnWorkspace.role === RoleEnum.ADMIN;
    } catch (e) {
      throw new BadRequestException('Forbidden');
    }
  }

  async getInvitesForUser(email: string) {
    const invites = await this.prisma.invite.findMany({
      where: { emailId: email, deleted: null },
    });

    return await Promise.all(
      invites.map(async (invite) => {
        const workspace = await this.prisma.workspace.findUnique({
          where: { id: invite.workspaceId },
        });

        return { ...invite, workspace };
      }),
    );
  }

  async createPersonalAccessToken(
    name: string,
    userId: string,
    workspaceId: string,
    type = 'user',
  ) {
    const token = generatePersonalAccessToken();

    // The `jwt` column is vestigial: authentication resolves a token against
    // this table and never reads the column. It used to hold an
    // access token minted here, but since identity moved into the database
    // (ENG-42) minting one requires a SuperTokens *recipe* id, and this was
    // handing it an account id — which `createNewSession` rejects, breaking
    // every PAT creation. Nothing needs the value, so it is no longer minted.
    const pat = await this.prisma.personalAccessToken.create({
      data: {
        name,
        userId,
        token,
        workspaceId,
        jwt: '',
        type,
      },
    });

    return { name, token, id: pat.id };
  }

  /**
   * Provisions an agent account: a login-less identity that acts as itself in
   * the workspace, so an agent's edits are attributed to the agent rather than
   * to the person who connected it.
   *
   * An agent authenticates only with a personal access token. It is still given
   * a passwordless credential it never uses interactively — the synthetic
   * address receives nothing — so its identity resolves the same way a person's
   * does. The token is returned once and is not retrievable afterwards.
   *
   * The membership records whether the agent is `personal` — owned by the
   * person who made it, to drive their own client — or `workspace`-owned by the
   * app. Only personal agents are provisioned today; the distinction is stored
   * from the start so later, app-owned agents are a new ownership rather than a
   * retrofit. An agent is never a BOT: that role is for the actions feature's
   * automations, a separate kind of principal.
   *
   * It also records the agent's scopes. The default is read and write but not
   * delete, so an agent can do the whole issue workflow without holding the one
   * verb that cannot be undone.
   */
  async createAgentAccount(
    workspaceId: string,
    name: string,
    createdByUserId: string,
    ownership: AgentOwnership = 'personal',
    scopes: AgentScope[] = DEFAULT_AGENT_SCOPES,
  ): Promise<AgentAccount> {
    const slug =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'agent';
    const email = `agent-${slug}-${randomBytes(4).toString('hex')}@agents.vantik.local`;

    const signUp = await Passwordless.signInUp({ tenantId: 'public', email });
    if (signUp.status !== 'OK') {
      throw new InternalServerErrorException(
        `Could not create the agent credential: ${signUp.status}`,
      );
    }

    await this.upsertUserForIdentity(
      signUp.recipeUserId.getAsString(),
      'passwordless',
      email,
      name,
    );

    // The passwordless sign-up derives a name from the synthetic address, so
    // set the display name explicitly — this is how the agent reads in history,
    // lists and assignments. `type` marks it non-human everywhere, not only in
    // the workspace whose membership carries the AGENT role.
    const user = await this.prisma.user.update({
      where: { email },
      data: { fullname: name, type: UserTypeEnum.Agent },
    });

    const teamIds = (
      await this.prisma.team.findMany({
        where: { workspaceId },
        select: { id: true },
      })
    ).map((team) => team.id);

    // A personal agent belongs to the person who made it; a workspace-owned one
    // belongs to no individual.
    const ownerUserId = ownership === 'personal' ? createdByUserId : null;

    await this.prisma.usersOnWorkspaces.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
      update: { role: RoleEnum.AGENT },
      create: {
        userId: user.id,
        workspaceId,
        role: RoleEnum.AGENT,
        teamIds,
        joinedAt: new Date(),
        settings: { agent: { ownership, ownerUserId, scopes } },
      },
    });

    const pat = await this.createPersonalAccessToken(
      name,
      user.id,
      workspaceId,
      'agent',
    );

    this.logger.info({
      message: `Provisioned ${ownership} agent account ${user.id} in workspace ${workspaceId} with scopes ${scopes.join(', ')} (by ${createdByUserId})`,
      where: 'UsersService.createAgentAccount',
    });

    return {
      id: user.id,
      name,
      email,
      ownership,
      ownerUserId,
      scopes,
      token: pat.token,
    };
  }

  /**
   * The agent accounts in a workspace, for the provisioning screen. Ownership
   * lives in the membership `settings.agent` blob written at creation; `active`
   * reflects whether an agent-typed token still exists, since a revoked agent
   * keeps its identity (so its past edits stay attributed) but loses access.
   */
  async listAgentAccounts(workspaceId: string): Promise<AgentSummary[]> {
    const memberships = await this.prisma.usersOnWorkspaces.findMany({
      where: { workspaceId, role: RoleEnum.AGENT },
      include: { user: true },
      orderBy: { joinedAt: 'desc' },
    });

    const activeTokenUserIds = new Set(
      (
        await this.prisma.personalAccessToken.findMany({
          where: {
            workspaceId,
            type: 'agent',
            deleted: null,
            userId: { in: memberships.map((m) => m.userId) },
          },
          select: { userId: true },
        })
      ).map((pat) => pat.userId),
    );

    return memberships.map((membership) => ({
      id: membership.user.id,
      name: membership.user.fullname,
      email: membership.user.email,
      // Read through the same helper the guard uses, so the screen shows what
      // is actually enforced rather than what happens to be stored.
      ...agentSettings(membership.settings),
      createdAt: (
        membership.joinedAt ?? membership.user.createdAt
      ).toISOString(),
      active: activeTokenUserIds.has(membership.user.id),
    }));
  }

  /**
   * Revokes an agent's access by soft-deleting its tokens in this workspace.
   * The account and its authored history are left intact; only its ability to
   * authenticate is removed. Scoped to the workspace and to agent-typed tokens
   * so it can never touch a person's PATs.
   */
  async revokeAgent(workspaceId: string, agentId: string): Promise<void> {
    const membership = await this.prisma.usersOnWorkspaces.findFirst({
      where: { workspaceId, userId: agentId, role: RoleEnum.AGENT },
    });
    if (!membership) {
      throw new NotFoundException(
        `No agent ${agentId} in this workspace to revoke.`,
      );
    }

    await this.prisma.personalAccessToken.updateMany({
      where: { workspaceId, userId: agentId, type: 'agent', deleted: null },
      data: { deleted: new Date() },
    });

    this.logger.info({
      message: `Revoked agent account ${agentId} in workspace ${workspaceId}`,
      where: 'UsersService.revokeAgent',
    });
  }

  async getPats(userId: string) {
    const pats = (
      await this.prisma.personalAccessToken.findMany({
        where: { userId, type: 'user', deleted: null },
      })
    ).map((pat) => ({ name: pat.name, id: pat.id }));

    return pats;
  }

  async deletePat(patId: string) {
    await this.prisma.personalAccessToken.update({
      where: { id: patId },
      data: {
        deleted: new Date(),
      },
    });
  }

  /**
   * Who a personal access token speaks for. Null for an unknown or revoked
   * token, which is how a bad token surfaces as a 401 rather than a 500.
   */
  async resolvePat(
    token: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request?: any,
  ): Promise<PatPrincipal | null> {
    return resolvePatPrincipal(this.prisma, token, request);
  }

  // Authorization code
  // Used in cli
  async generateAuthorizationCode() {
    return this.prisma.authorizationCode.create({
      data: {
        code: generateUniqueId(),
      },
      select: {
        code: true,
      },
    });
  }

  async authorizeCode(userId: string, codeBody: CodeDtoWithWorkspace) {
    // only allow authorization codes that were created less than 10 mins ago
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const code = await this.prisma.authorizationCode.findFirst({
      where: {
        code: codeBody.code,
        personalAccessTokenId: null,
        createdAt: {
          gte: tenMinutesAgo,
        },
      },
    });

    if (!code) {
      throw new Error(
        'Invalid authorization code, code already used, or code expired',
      );
    }

    const existingCliPersonalAccessToken =
      await this.prisma.personalAccessToken.findFirst({
        where: {
          userId,
          type: 'cli',
        },
      });

    // we only allow you to have one CLI PAT at a time, so return this
    if (existingCliPersonalAccessToken) {
      // associate this authorization code with the existing personal access token
      await this.prisma.authorizationCode.updateMany({
        where: {
          code: codeBody.code,
        },
        data: {
          personalAccessTokenId: existingCliPersonalAccessToken.id,
          workspaceId: codeBody.workspaceId,
        },
      });

      if (existingCliPersonalAccessToken.deleted) {
        // re-activate revoked CLI PAT so we can use it again
        await this.prisma.personalAccessToken.update({
          where: {
            id: existingCliPersonalAccessToken.id,
          },
          data: {
            deleted: null,
          },
        });
      }

      // we don't return the decrypted token
      return {
        id: existingCliPersonalAccessToken.id,
        name: existingCliPersonalAccessToken.name,
        userId: existingCliPersonalAccessToken.userId,
      };
    }

    // The workspace being logged into, not the literal string 'cli' this used
    // to pass as the workspace id. A token acts in the workspace it names, so a
    // token naming a workspace that does not exist can act nowhere at all.
    const token = await this.createPersonalAccessToken(
      'cli',
      userId,
      codeBody.workspaceId,
    );

    await this.prisma.authorizationCode.updateMany({
      where: {
        code: codeBody.code,
      },
      data: {
        personalAccessTokenId: token.id,
        workspaceId: codeBody.workspaceId,
      },
    });

    return token;
  }

  /** Gets a PersonalAccessToken from an Auth Code, this only works within 10 mins of the auth code being created */
  async getPersonalAccessTokenFromAuthorizationCode(authorizationCode: string) {
    // only allow authorization codes that were created less than 10 mins ago
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const code = await this.prisma.authorizationCode.findFirst({
      where: {
        code: authorizationCode,
        createdAt: {
          gte: tenMinutesAgo,
        },
      },
    });
    if (!code) {
      throw new Error('Invalid authorization code, or code expired');
    }

    if (!code.personalAccessTokenId) {
      throw new Error('No personal token found');
    }

    const pat = await this.prisma.personalAccessToken.findUnique({
      where: { id: code.personalAccessTokenId },
    });

    // there's no PersonalAccessToken associated with this code
    if (!pat) {
      return {
        token: null,
        workspaceId: undefined,
      };
    }

    return {
      token: pat.token,
      workspaceId: code.workspaceId,
    };
  }

  // Impersonate into accounts for better support
  async impersonate(key: string, userId: string, res: Response, req: Request) {
    if (key !== this.config.get('POSTGRES_PASSWORD')) {
      throw new BadRequestException('Wrong URL');
    }

    const user = this.prisma.user.findUnique({
      where: {
        id: userId,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await Session.createNewSession(
      req,
      res,
      'public',
      supertokens.convertToRecipeUserId(userId),
    );

    res.send({ status: 200, message: 'impersonate' });
  }
}
