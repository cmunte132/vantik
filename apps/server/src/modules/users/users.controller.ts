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

import { AdminGuard } from './admin.guard';
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
   */
  @Post('agents')
  @UseGuards(AuthGuard, AdminGuard)
  async createAgentAccount(
    @Workspace() workspaceId: string,
    @SessionDecorator() session: SessionContainer,
    @Body() createAgentDto: CreateAgentDto,
  ): Promise<AgentAccount> {
    const createdByUserId = getAppUserId(session);
    return await this.users.createAgentAccount(
      workspaceId,
      createAgentDto.name,
      createdByUserId,
      'personal',
      sanitizeScopes(createAgentDto.scopes),
    );
  }

  /**
   * The agent accounts in this workspace, without tokens (a token exists only
   * at creation). Admin-only, mirroring the create path.
   */
  @Get('agents')
  @UseGuards(AuthGuard, AdminGuard)
  async listAgentAccounts(
    @Workspace() workspaceId: string,
  ): Promise<AgentSummary[]> {
    return await this.users.listAgentAccounts(workspaceId);
  }

  /**
   * Revokes an agent's access by deleting its tokens. The account is kept so
   * its past edits stay attributed; it simply can no longer authenticate.
   */
  @Post('agents/:agentId/revoke')
  @UseGuards(AuthGuard, AdminGuard)
  async revokeAgent(
    @Workspace() workspaceId: string,
    @Param() { agentId }: AgentIdParams,
  ): Promise<void> {
    return await this.users.revokeAgent(workspaceId, agentId);
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
  async deletePat(@Param() patIdDto: PatIdDto) {
    return await this.users.deletePat(patIdDto.patId);
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
