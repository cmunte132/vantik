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
import {
  ChecklistItem,
  ChecklistItemRequestParamsDto,
  CreateChecklistItemDto,
  CreateChecklistItemRequestParamsDto,
  UpdateChecklistItemDto,
} from '@vantikhq/types';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import { Session as SessionDecorator } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import ChecklistItemsService from './checklist-items.service';

@Controller({
  version: '1',
  path: 'checklist_items',
})
export class ChecklistItemsController {
  constructor(private checklistItemsService: ChecklistItemsService) {}

  @Get()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getChecklistItems(
    @Query() issueParams: CreateChecklistItemRequestParamsDto,
  ): Promise<ChecklistItem[]> {
    return this.checklistItemsService.getChecklistItems(issueParams);
  }

  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createChecklistItem(
    @SessionDecorator() session: SessionContainer,
    @Query() issueParams: CreateChecklistItemRequestParamsDto,
    @Body() itemData: CreateChecklistItemDto,
  ): Promise<ChecklistItem> {
    const userId = getAppUserId(session);
    return this.checklistItemsService.createChecklistItem(
      issueParams,
      userId,
      itemData,
    );
  }

  @Post(':checklistItemId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateChecklistItem(
    @SessionDecorator() session: SessionContainer,
    @Param() checklistItemParams: ChecklistItemRequestParamsDto,
    @Body() itemData: UpdateChecklistItemDto,
  ): Promise<ChecklistItem> {
    const userId = getAppUserId(session);
    return this.checklistItemsService.updateChecklistItem(
      checklistItemParams,
      userId,
      itemData,
    );
  }

  @Delete(':checklistItemId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteChecklistItem(
    @SessionDecorator() session: SessionContainer,
    @Param() checklistItemParams: ChecklistItemRequestParamsDto,
  ): Promise<ChecklistItem> {
    const userId = getAppUserId(session);
    return this.checklistItemsService.deleteChecklistItem(
      checklistItemParams,
      userId,
    );
  }
}
