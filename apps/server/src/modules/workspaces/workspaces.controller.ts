import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { Workspace, UpdateWorkspacePreferencesDto } from '@vantikhq/types';
import { Response } from 'express';
import { AuthSessionContext } from 'modules/auth/auth.interface';

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
    @SessionDecorator() session: AuthSessionContext,
    @Body() workspaceData: CreateInitialResourcesDto,
    @Res() res: Response,
  ) {
    await this.workspacesService.createInitialResources(
      session,
      workspaceData,
      res,
    );
  }

  @Get()
  @UseGuards(AuthGuard)
  async getAllWorkspaces(
    @SessionDecorator() session: AuthSessionContext,
  ): Promise<Workspace[]> {
    const userId = getAppUserId(session);
    return await this.workspacesService.getAllWorkspaces(userId);
  }

  @Post('invite_action')
  @UseGuards(AuthGuard)
  async inviteAction(
    @SessionDecorator() session: AuthSessionContext,
    @Body() inviteActionBody: InviteActionBody,
    @Res() response: Response,
  ) {
    return await this.workspacesService.inviteAction(
      response,
      inviteActionBody.inviteId,
      session,
      inviteActionBody.accept,
    );
  }

  // Admins only, as the settings page that sends it is. The preferences hold
  // the agent run defaults, limits included: what a run may spend on a model
  // key that someone else pays for.
  @Post('preferences')
  @UseGuards(AuthGuard, AdminGuard)
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

  @UseGuards(AuthGuard, AdminGuard)
  @Post('invite_users')
  async inviteUsers(
    @SessionDecorator() session: AuthSessionContext,
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
