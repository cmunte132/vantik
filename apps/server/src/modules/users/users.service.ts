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
import Passwordless from 'supertokens-node/recipe/passwordless';
import Session from 'supertokens-node/recipe/session';

import { generatePersonalAccessToken } from 'common/authentication';
import { PatPrincipal, resolvePatPrincipal } from 'common/pat-session';
import {
  assertWorkspaceAdmin,
  resolveAdminWorkspaceId,
  resolveMemberWorkspaceId,
} from 'common/workspace-access';

import { agentSettings } from 'modules/auth/agent-scope';
import { getRecipeUserIdForAccount } from 'modules/auth/session-user';
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
   * An identity for one run, which nobody has to manage.
   *
   * Delegating to a hosted sandbox should not first require somebody to
   * provision an agent account, choose it from a list of thirteen, and keep it
   * alive afterwards. Vantik runs the agent, so Vantik owns the identity: it is
   * created when the run is created, named something a person can tell apart in
   * a comment feed, and never offered as a thing to configure.
   *
   * **It is given no token.** That is the security property, not an omission:
   * a hosted run never calls the API as itself — the sandbox reports to the
   * host and the host does the writing — so there is nothing for a credential
   * to be needed for, and a credential that exists is one that can leak. It is
   * also what keeps the identity out of `listAgentAccounts`, which only shows a
   * hidden agent when it still has a live token.
   *
   * The row stays after the run, like every other agent identity, because it
   * authored a comment and may have opened a pull request. Attribution that
   * disappears is worse than a row nobody looks at.
   */
  async provisionRunIdentity(workspaceId: string, name: string) {
    const email = `run-${randomBytes(8).toString('hex')}@agents.vantik.local`;

    const signUp = await Passwordless.signInUp({ tenantId: 'public', email });
    if (signUp.status !== 'OK') {
      throw new InternalServerErrorException(
        `Could not create the run identity: ${signUp.status}`,
      );
    }

    await this.upsertUserForIdentity(
      signUp.recipeUserId.getAsString(),
      'passwordless',
      email,
      name,
    );

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { email },
        data: { fullname: name, type: UserTypeEnum.Agent },
      });

      const teamIds = (
        await tx.team.findMany({
          where: { workspaceId },
          select: { id: true },
        })
      ).map((team) => team.id);

      await tx.usersOnWorkspaces.create({
        data: {
          userId: user.id,
          workspaceId,
          role: RoleEnum.AGENT,
          teamIds,
          joinedAt: new Date(),
          // `hiddenAt` from birth: this is not an account, and listing it
          // beside the ones somebody deliberately made would turn Settings →
          // Agents into a list of every run the workspace has ever done.
          settings: {
            agent: {
              ownership: 'workspace',
              ownerUserId: null,
              scopes: [],
              ephemeral: true,
              hiddenAt: new Date().toISOString(),
            },
          },
        },
      });

      return { id: user.id, name };
    });
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
   * person who made it, to drive their own client — or `workspace`-owned, a
   * shared credential for CI, a scheduled job or a shared runner, stored with a
   * null `ownerUserId` so an admin rather than an owner retires it. An agent is
   * never a BOT: that role is for the actions feature's automations, a separate
   * kind of principal.
   *
   * It also records the agent's scopes. The default is read and write but not
   * delete, so an agent can do the whole issue workflow without holding the one
   * verb that cannot be undone.
   */
  async createAgentAccount(
    sessionWorkspaceId: string,
    name: string,
    createdByUserId: string,
    ownership: AgentOwnership = 'personal',
    scopes: AgentScope[] = DEFAULT_AGENT_SCOPES,
    requestedWorkspaceId?: string,
  ): Promise<AgentAccount> {
    // Any member may mint a *personal* agent: it is the credential they point
    // their own editor at, and gating that behind admin made the feature
    // unavailable to most of the people it exists for. A workspace-owned agent
    // acts for the whole workspace and stays admin-only — the load-bearing
    // half, and the one easiest to lose while splitting these two checks.
    const workspaceId = await resolveMemberWorkspaceId(
      this.prisma,
      createdByUserId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    if (ownership !== 'personal') {
      await assertWorkspaceAdmin(this.prisma, createdByUserId, workspaceId);
    }

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

    // A personal agent belongs to the person who made it; a workspace-owned one
    // belongs to no individual.
    const ownerUserId = ownership === 'personal' ? createdByUserId : null;
    const agentSettingsBlob = { agent: { ownership, ownerUserId, scopes } };

    // One transaction, because the half-finished states are worse than a failed
    // provision. An account marked `type: Agent` with a live credential but no
    // membership is invisible to `listAgentAccounts` (which reads memberships)
    // and unreachable by `revokeAgent` (which requires one), so it could only be
    // cleaned up by hand in the database. An agent with a membership but no
    // token would show on the screen as permanently revoked.
    const { user, token } = await this.prisma.$transaction(async (tx) => {
      // The passwordless sign-up derives a name from the synthetic address, so
      // set the display name explicitly — this is how the agent reads in
      // history, lists and assignments. `type` marks it non-human everywhere,
      // not only in the workspace whose membership carries the AGENT role.
      const user = await tx.user.update({
        where: { email },
        data: { fullname: name, type: UserTypeEnum.Agent },
      });

      const teamIds = (
        await tx.team.findMany({
          where: { workspaceId },
          select: { id: true },
        })
      ).map((team) => team.id);

      await tx.usersOnWorkspaces.upsert({
        where: { userId_workspaceId: { userId: user.id, workspaceId } },
        // `settings` is written on both branches. Left off the update, an
        // existing membership kept whatever it already had while this method
        // still returned the scopes it was asked for — so the screen and the
        // API claimed a grant the guard was not enforcing.
        update: { role: RoleEnum.AGENT, settings: agentSettingsBlob },
        create: {
          userId: user.id,
          workspaceId,
          role: RoleEnum.AGENT,
          teamIds,
          joinedAt: new Date(),
          settings: agentSettingsBlob,
        },
      });

      // Inlined rather than calling createPersonalAccessToken, which holds its
      // own client and so would commit outside this transaction.
      const token = generatePersonalAccessToken();
      await tx.personalAccessToken.create({
        data: {
          name,
          userId: user.id,
          token,
          workspaceId,
          jwt: '',
          type: 'agent',
        },
      });

      return { user, token };
    });

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
      token,
      // Minted a moment ago and not yet used for anything. Null rather than
      // omitted, because "never used" is the flag the settings list puts on a
      // leftover, and it has to be true from the start for that to mean
      // anything.
      lastUsedAt: null,
    };
  }

  /**
   * The agent accounts in a workspace, for the provisioning screen. Ownership
   * lives in the membership `settings.agent` blob written at creation; `active`
   * reflects whether an agent-typed token still exists, since a revoked agent
   * keeps its identity (so its past edits stay attributed) but loses access.
   */
  async listAgentAccounts(
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId?: string,
    scope: 'mine' | 'all' = 'all',
  ): Promise<AgentSummary[]> {
    // `mine` is an ordinary member read — you are always allowed to see the
    // agents you own. `all` is the admin view of everything operating in the
    // workspace.
    const workspaceId =
      scope === 'mine'
        ? await resolveMemberWorkspaceId(
            this.prisma,
            userId,
            sessionWorkspaceId,
            requestedWorkspaceId,
          )
        : await resolveAdminWorkspaceId(
            this.prisma,
            userId,
            sessionWorkspaceId,
            requestedWorkspaceId,
          );

    const memberships = (
      await this.prisma.usersOnWorkspaces.findMany({
        where: { workspaceId, role: RoleEnum.AGENT },
        include: { user: true },
        orderBy: { joinedAt: 'desc' },
      })
    ).filter((membership) =>
      // Filtered in application code rather than in the query: ownership lives
      // inside a JSON settings blob, and reading it through the same helper the
      // guard uses is what keeps the screen honest about what is enforced.
      scope === 'mine'
        ? agentSettings(membership.settings).ownerUserId === userId
        : true,
    );

    // Every token, not only the live ones: a revoked agent still answers "was
    // this ever used", and that is exactly what decides whether clearing it
    // loses anything.
    const tokens = await this.prisma.personalAccessToken.findMany({
      where: {
        workspaceId,
        type: 'agent',
        userId: { in: memberships.map((m) => m.userId) },
      },
      select: { userId: true, deleted: true, lastUsedAt: true },
    });

    const activeTokenUserIds = new Set(
      tokens.filter((pat) => !pat.deleted).map((pat) => pat.userId),
    );

    // An agent may hold more than one token over its life, so its last use is
    // the most recent across all of them.
    const lastUsedByUser = new Map<string, Date>();
    for (const pat of tokens) {
      if (!pat.lastUsedAt) {
        continue;
      }
      const current = lastUsedByUser.get(pat.userId);
      if (!current || pat.lastUsedAt > current) {
        lastUsedByUser.set(pat.userId, pat.lastUsedAt);
      }
    }

    return memberships
      .filter((membership) => {
        // A cleared agent leaves the listing but keeps its account, its
        // membership and everything it authored, so attribution on past issues
        // and comments still resolves. Only ever hides a revoked one — hiding a
        // live agent would conceal something that can still act.
        const hidden = agentSettings(membership.settings).hiddenAt;
        return !hidden || activeTokenUserIds.has(membership.userId);
      })
      .map((membership) => {
        // Read through the same helper the guard uses, so the screen shows what
        // is actually enforced rather than what happens to be stored. `hiddenAt`
        // is a listing concern and has no business on the wire.
        const { hiddenAt: _hiddenAt, ...granted } = agentSettings(
          membership.settings,
        );

        return {
          id: membership.user.id,
          name: membership.user.fullname,
          email: membership.user.email,
          ...granted,
          createdAt: (
            membership.joinedAt ?? membership.user.createdAt
          ).toISOString(),
          active: activeTokenUserIds.has(membership.user.id),
          lastUsedAt:
            lastUsedByUser.get(membership.user.id)?.toISOString() ?? null,
        };
      });
  }

  /**
   * Hides every revoked agent in the workspace from the listing.
   *
   * Hides rather than deletes, and the distinction is the whole point: these
   * accounts authored issues and comments, so removing the user would break
   * attribution on real records that mention them. A revoked agent can no
   * longer authenticate, so the row is the only thing left to remove.
   *
   * Deliberately never touches a live agent, whatever it is asked.
   */
  async clearRevokedAgents(
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId?: string,
  ): Promise<{ hidden: number }> {
    const workspaceId = await resolveAdminWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    const agents = await this.listAgentAccounts(
      sessionWorkspaceId,
      userId,
      requestedWorkspaceId,
      'all',
    );

    const revoked = agents.filter((agent) => !agent.active);
    const now = new Date().toISOString();

    for (const agent of revoked) {
      const membership = await this.prisma.usersOnWorkspaces.findUnique({
        where: { userId_workspaceId: { userId: agent.id, workspaceId } },
        select: { settings: true },
      });

      if (!membership) {
        continue;
      }

      const settings = (membership.settings ?? {}) as Record<string, unknown>;
      const agentBlob = (settings.agent ?? {}) as Record<string, unknown>;

      await this.prisma.usersOnWorkspaces.update({
        where: { userId_workspaceId: { userId: agent.id, workspaceId } },
        data: {
          settings: { ...settings, agent: { ...agentBlob, hiddenAt: now } },
        },
      });
    }

    return { hidden: revoked.length };
  }

  /**
   * Revokes an agent's access by soft-deleting its tokens in this workspace.
   * The account and its authored history are left intact; only its ability to
   * authenticate is removed. Scoped to the workspace and to agent-typed tokens
   * so it can never touch a person's PATs.
   */
  async revokeAgent(
    sessionWorkspaceId: string,
    agentId: string,
    userId: string,
    requestedWorkspaceId?: string,
  ): Promise<void> {
    const workspaceId = await resolveMemberWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    const membership = await this.prisma.usersOnWorkspaces.findFirst({
      where: { workspaceId, userId: agentId, role: RoleEnum.AGENT },
    });
    if (!membership) {
      throw new NotFoundException(
        `No agent ${agentId} in this workspace to revoke.`,
      );
    }

    // An owner may always cut off their own agent; anyone else needs admin.
    // Checked after the membership lookup so a foreign agent id is a 404
    // rather than a 403 that confirms the agent exists.
    if (agentSettings(membership.settings).ownerUserId !== userId) {
      await assertWorkspaceAdmin(this.prisma, userId, workspaceId);
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

  /**
   * Revokes one of the caller's own tokens.
   *
   * The owner is part of the `where`, not checked before it: an id belonging to
   * somebody else simply matches nothing. Taking the id alone meant any
   * authenticated caller could revoke any token on the server — including every
   * other workspace's CLI tokens and every agent's — which an agent granted the
   * `delete` scope could do on a loop. `updateMany` is what allows the owner in
   * the filter, and it reports how many rows it touched, so a foreign or
   * unknown id is answered with a 404 rather than silently doing nothing.
   */
  async deletePat(patId: string, userId: string) {
    const { count } = await this.prisma.personalAccessToken.updateMany({
      where: { id: patId, userId, deleted: null },
      data: {
        deleted: new Date(),
      },
    });

    if (count === 0) {
      throw new NotFoundException(`No token ${patId} to delete.`);
    }
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
      await getRecipeUserIdForAccount(this.prisma, userId),
    );

    res.send({ status: 200, message: 'impersonate' });
  }
}
