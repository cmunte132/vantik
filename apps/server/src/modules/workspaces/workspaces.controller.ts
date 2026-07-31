import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  UsersOnWorkspaces,
  Workspace,
  WorkspaceRequestParamsDto,
  UpdateWorkspacePreferencesDto,
} from '@vantikhq/types';
import { Request, Response } from 'express';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import { Session as SessionDecorator } from 'modules/auth/session.decorator';
import { Workspace as WorkspaceD } from 'modules/auth/session.decorator';
import { AdminGuard } from 'modules/users/admin.guard';

import {
  CreateInitialResourcesDto,
  InviteActionBody,
  InviteUsersBody,
  UpdateWorkspaceInput,
  UserBody,
} from './workspaces.interface';
import WorkspacesService from './workspaces.service';

@Controller({
  version: '1',
  path: 'workspaces',
})
export class WorkspacesController {
  constructor(private workspacesService: WorkspacesService) {}

  @Post('onboarding')
  @UseGuards(AuthGuard)
  async createIntialResources(
    @SessionDecorator() session: SessionContainer,
    @Body() workspaceData: CreateInitialResourcesDto,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    await this.workspacesService.createInitialResources(
      session,
      workspaceData,
      res,
      req,
    );
  }

  @Get()
  @UseGuards(AuthGuard)
  async getAllWorkspaces(
    @SessionDecorator() session: SessionContainer,
  ): Promise<Workspace[]> {
    const userId = getAppUserId(session);
    return await this.workspacesService.getAllWorkspaces(userId);
  }

  @Post('invite_action')
  @UseGuards(AuthGuard)
  async inviteAction(
    @SessionDecorator() session: SessionContainer,
    @Body() inviteActionBody: InviteActionBody,
    @Res() response: Response,
    @Req() request: Request,
  ) {
    return await this.workspacesService.inviteAction(
      request,
      response,
      inviteActionBody.inviteId,
      session,
      inviteActionBody.accept,
    );
  }

  @Post('preferences')
  @UseGuards(AuthGuard)
  async updateWorkspacePreferences(
    @WorkspaceD() workspaceId: string,
    @Body() workspaceData: UpdateWorkspacePreferencesDto,
  ): Promise<Workspace> {
    return await this.workspacesService.updateWorkspacePreferences(
      workspaceId,
      workspaceData,
    );
  }

  @Post('suspend')
  @UseGuards(AuthGuard, AdminGuard)
  async suspendUser(
    @WorkspaceD() workspaceId: string,
    @Body() userBody: UserBody,
  ) {
    return await this.workspacesService.suspendUser(
      workspaceId,
      userBody.userId,
    );
  }

  @Post('add_users')
  @UseGuards(AuthGuard)
  async addUserToWorkspace(
    @WorkspaceD() workspaceId: string,
    @Body() UserBody: UserBody,
  ): Promise<UsersOnWorkspaces> {
    return await this.workspacesService.addUserToWorkspace(
      workspaceId,
      UserBody.userId,
    );
  }

  @Post()
  @UseGuards(AuthGuard)
  async updateWorkspace(
    @WorkspaceD() workspaceId: string,
    @Body() workspaceData: UpdateWorkspaceInput,
  ): Promise<Workspace> {
    return await this.workspacesService.updateWorkspace(
      workspaceId,
      workspaceData,
    );
  }

  @Delete()
  @UseGuards(AuthGuard)
  async deleteWorkspace(@WorkspaceD() workspaceId: string): Promise<Workspace> {
    return await this.workspacesService.deleteWorkspace(workspaceId);
  }

  @Get('invites')
  @UseGuards(AuthGuard)
  async invitedUsers(
    @Param() WorkspaceRequestParamsDto: WorkspaceRequestParamsDto,
  ) {
    return await this.workspacesService.getInvites(
      WorkspaceRequestParamsDto.workspaceId,
    );
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('invite_users')
  async inviteUsers(
    @SessionDecorator() session: SessionContainer,
    @WorkspaceD() workspaceId: string,
    @Body() inviteUsersBody: InviteUsersBody,
  ) {
    return await this.workspacesService.inviteUsers(
      session,
      workspaceId,
      inviteUsersBody,
    );
  }
}
