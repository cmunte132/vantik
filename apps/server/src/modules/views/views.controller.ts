import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { View } from '@vantikhq/types';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import { Session, Workspace } from 'modules/auth/session.decorator';

import {
  CreateViewsRequestBody,
  UpdateViewsRequestBody,
  ViewRequestIdBody,
} from './views.interface';
import { ViewsService } from './views.service';

@Controller({
  version: '1',
  path: 'views',
})
export class ViewsController {
  constructor(private viewsService: ViewsService) {}

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
