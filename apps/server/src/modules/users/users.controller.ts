import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  AgentAccount,
  AgentSummary,
  CodeDto,
  CodeDtoWithWorkspace,
  CreatePatDto,
  GetUsersDto,
  PatIdDto,
  PublicUser,
  User,
} from '@vantikhq/types';
import { Response } from 'express';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { RequiresScope, sanitizeScopes } from 'modules/auth/agent-scope';
import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import {
  Session as SessionDecorator,
  UserId,
  Workspace,
} from 'modules/auth/session.decorator';

import {
  AgentIdParams,
  CreateAgentDto,
  UpdateUserBody,
  UserWithInvites,
} from './users.interface';
import { UsersService } from './users.service';

@Controller({
  version: '1',
  path: 'users',
})
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  @UseGuards(AuthGuard)
  async getUser(
    @SessionDecorator() session: SessionContainer,
    @Query() userIdParams: { userIds: string },
    @Workspace() workspaceId: string,
  ): Promise<UserWithInvites | PublicUser[]> {
    try {
      if (userIdParams.userIds && userIdParams.userIds.split(',').length > 0) {
        return await this.users.getUsersbyId(
          {
            userIds: userIdParams.userIds.split(','),
          },
          workspaceId,
        );
      }
    } catch (e) {}

    const userId = getAppUserId(session);
    const user = await this.users.getUser(userId);

    return user;
  }

  // Reads a set of users; POST only because the id list travels in the body.
  @RequiresScope('read')
  @Post()
  @UseGuards(AuthGuard)
  async getUsersById(
    @Body() getUsersDto: GetUsersDto,
    @Workspace() workspaceId: string,
  ): Promise<PublicUser[]> {
    return await this.users.getUsersbyId(getUsersDto, workspaceId);
  }

  @Post('impersonate')
  @UseGuards(AuthGuard)
  async impersonate(
    @Body() { key, userId }: { key: string; userId: string },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    return this.users.impersonate(key, userId, res, req);
  }

  @Post('pat')
  @UseGuards(AuthGuard)
  async createPersonalAccessToken(
    @Workspace() workspaceId: string,
    @SessionDecorator() session: SessionContainer,
    @Body()
    createPatDto: CreatePatDto,
  ) {
    const userId = getAppUserId(session);
    const user = await this.users.createPersonalAccessToken(
      createPatDto.name,
      userId,
      workspaceId,
    );

    return user;
  }

  /**
   * Provisions an agent account and returns its personal access token once.
   * Admin-only: an agent acts as a distinct identity in the workspace, so
   * minting one is a privileged action. Drop the returned token into an MCP
   * client's Authorization header to have that client act as the agent.
   *
   * `ownership` chooses between an agent belonging to the caller and one
   * belonging to the workspace itself; it defaults to personal, which is what
   * this passed unconditionally before workspace agents could be asked for.
   */
  @Post('agents')
  @UseGuards(AuthGuard)
  async createAgentAccount(
    @Workspace() workspaceId: string,
    @SessionDecorator() session: SessionContainer,
    @Body() createAgentDto: CreateAgentDto,
    @Query('workspaceId') requestedWorkspaceId?: string,
  ): Promise<AgentAccount> {
    const createdByUserId = getAppUserId(session);
    return await this.users.createAgentAccount(
      workspaceId,
      createAgentDto.name,
      createdByUserId,
      createAgentDto.ownership ?? 'personal',
      sanitizeScopes(createAgentDto.scopes),
      requestedWorkspaceId,
    );
  }

  /**
   * The agent accounts in this workspace, without tokens (a token exists only
   * at creation).
   *
   * `scope=mine` is the account-settings view — the agents you own, readable
   * by any member. The default `all` is the admin view of every agent
   * operating in the workspace, since agents author changes attributed to them
   * and an admin needs to be able to see and cut off one they did not create.
   */
  @Get('agents')
  @UseGuards(AuthGuard)
  async listAgentAccounts(
    @Workspace() workspaceId: string,
    @SessionDecorator() session: SessionContainer,
    @Query('workspaceId') requestedWorkspaceId?: string,
    @Query('scope') scope?: 'mine' | 'all',
  ): Promise<AgentSummary[]> {
    return await this.users.listAgentAccounts(
      workspaceId,
      getAppUserId(session),
      requestedWorkspaceId,
      scope === 'mine' ? 'mine' : 'all',
    );
  }

  /**
   * Clears revoked agents out of the listing.
   *
   * Hides, never deletes. These accounts authored issues and comments, so
   * removing the user would break attribution on records that still reference
   * them; a revoked agent cannot authenticate, so the listing row is the only
   * thing left worth removing. Live agents are untouched.
   *
   * Declared above `agents/:agentId/revoke` so the literal path is matched
   * before the parameterised one.
   */
  @Post('agents/clear_revoked')
  @UseGuards(AuthGuard)
  async clearRevokedAgents(
    @Workspace() workspaceId: string,
    @SessionDecorator() session: SessionContainer,
    @Query('workspaceId') requestedWorkspaceId?: string,
  ): Promise<{ hidden: number }> {
    return await this.users.clearRevokedAgents(
      workspaceId,
      getAppUserId(session),
      requestedWorkspaceId,
    );
  }

  /**
   * Revokes an agent's access by deleting its tokens. The account is kept so
   * its past edits stay attributed; it simply can no longer authenticate.
   *
   * An owner can always revoke their own agent; revoking anyone else's needs
   * admin.
   */
  @Post('agents/:agentId/revoke')
  @UseGuards(AuthGuard)
  async revokeAgent(
    @Workspace() workspaceId: string,
    @Param() { agentId }: AgentIdParams,
    @SessionDecorator() session: SessionContainer,
    @Query('workspaceId') requestedWorkspaceId?: string,
  ): Promise<void> {
    return await this.users.revokeAgent(
      workspaceId,
      agentId,
      getAppUserId(session),
      requestedWorkspaceId,
    );
  }

  @Post('pat-for-code')
  async getPatForCode(
    @Body()
    codeBody: CodeDto,
  ) {
    return await this.users.getPersonalAccessTokenFromAuthorizationCode(
      codeBody.code,
    );
  }

  @Get('pats')
  @UseGuards(AuthGuard)
  async getPats(@SessionDecorator() session: SessionContainer) {
    const userId = getAppUserId(session);
    return await this.users.getPats(userId);
  }

  @Delete('pats/:patId')
  @UseGuards(AuthGuard)
  async deletePat(
    @Param() patIdDto: PatIdDto,
    @SessionDecorator() session: SessionContainer,
  ) {
    // The owner is passed down and applied in the query: a token id alone says
    // nothing about whose token it is, and this route is reachable by any
    // authenticated caller, agents included.
    return await this.users.deletePat(patIdDto.patId, getAppUserId(session));
  }

  @Get('authorization')
  async createAuthorizationCode(): Promise<CodeDto> {
    return this.users.generateAuthorizationCode();
  }

  @Post('authorization')
  @UseGuards(AuthGuard)
  async authorizeCode(
    @SessionDecorator() session: SessionContainer,
    @Body()
    codeBody: CodeDtoWithWorkspace,
  ) {
    const userId = getAppUserId(session);
    return this.users.authorizeCode(userId, codeBody);
  }

  @Put()
  @UseGuards(AuthGuard)
  async updateUser(
    @UserId() userId: string,
    @Body()
    updateUserBody: UpdateUserBody,
  ): Promise<User> {
    const user = await this.users.updateUser(userId, updateUserBody);
    return user;
  }
}
