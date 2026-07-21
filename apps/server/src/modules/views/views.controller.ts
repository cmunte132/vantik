import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { View } from '@vantikhq/types';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import { Session, UserId, Workspace } from 'modules/auth/session.decorator';

import {
  CreateViewsRequestBody,
  UpdateViewsRequestBody,
  ViewRequestIdBody,
  ViewsRequestBody,
} from './views.interface';
import { ViewsService } from './views.service';

@Controller({
  version: '1',
  path: 'views',
})
export class ViewsController {
  constructor(private viewsService: ViewsService) {}

  /**
   * Get all views for the workspace
   */
  @Get()
  @UseGuards(AuthGuard)
  async getViews(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query()
    viewsRequestBody: ViewsRequestBody,
  ): Promise<View[]> {
    return await this.viewsService.getViews(
      sessionWorkspaceId,
      userId,
      viewsRequestBody.workspaceId,
    );
  }

  /**
   * Get a view
   */
  @Get(':viewId')
  @UseGuards(AuthGuard)
  async getViewById(
    @Param()
    viewRequestIdBody: ViewRequestIdBody,
  ): Promise<View> {
    return await this.viewsService.getViewById(viewRequestIdBody.viewId);
  }

  /**
   * Delete a View
   */
  @Delete(':viewId')
  @UseGuards(AuthGuard)
  async deleteView(
    @Param()
    viewRequestIdBody: ViewRequestIdBody,
  ) {
    return await this.viewsService.deleteView(viewRequestIdBody.viewId);
  }

  /**
   * Update a view in workspace
   */
  @Post(':viewId')
  @UseGuards(AuthGuard)
  async updateView(
    @Param()
    viewRequestIdBody: ViewRequestIdBody,
    @Body()
    updateViewBody: UpdateViewsRequestBody,
  ): Promise<View> {
    return await this.viewsService.updateView(
      viewRequestIdBody.viewId,
      updateViewBody,
    );
  }

  /**
   * Create view in a workspace
   */
  @Post()
  @UseGuards(AuthGuard)
  async createView(
    @Session() session: SessionContainer,
    @Workspace() sessionWorkspaceId: string,
    @Body()
    createViewBody: CreateViewsRequestBody,
  ): Promise<View> {
    const userId = getAppUserId(session);

    return await this.viewsService.createView(
      createViewBody,
      userId,
      sessionWorkspaceId,
    );
  }
}
