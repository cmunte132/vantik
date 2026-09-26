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
  CreateLabelDto,
  Label,
  LabelRequestParamsDto,
  UpdateLabelDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { RequestIdParams } from './labels.interface';
import LabelsService from './labels.service';

// Every route carries WorkspaceResourceGuard. The id routes name the label and
// nothing else, and create and update can name a team and a group label, so
// each of those is proved to be the caller's own before the service runs.
@Controller({
  version: '1',
  path: 'labels',
})
export class LabelsController {
  constructor(private labelsService: LabelsService) {}

  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createLabel(
    @Body() labelData: CreateLabelDto,
    @UserId() userId: string,
    @Workspace() workspaceId: string,
  ): Promise<Label> {
    return await this.labelsService.createLabel(labelData, userId, workspaceId);
  }

  @Get()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getAllLabels(
    @Query() requestParams: RequestIdParams,
    @UserId() userId: string,
    @Workspace() workspaceId: string,
  ): Promise<Label[]> {
    return await this.labelsService.getAllLabels(
      requestParams,
      userId,
      workspaceId,
    );
  }

  @Post(':labelId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateLabel(
    @Param()
    labelId: LabelRequestParamsDto,
    @Body() labelData: UpdateLabelDto,
  ): Promise<Label> {
    return await this.labelsService.updateLabel(labelId, labelData);
  }

  @Delete(':labelId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteLabel(
    @Param()
    labelId: LabelRequestParamsDto,
  ): Promise<Label> {
    return await this.labelsService.deleteLabel(labelId);
  }
}
