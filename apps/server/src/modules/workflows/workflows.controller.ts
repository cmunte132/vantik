import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreateWorkflowDTO,
  UpdateWorkflowDTO,
  Workflow,
  WorkflowRequestParamsDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import WorkflowsService from './workflows.service';

// Every route carries WorkspaceResourceGuard, which proves the `:teamId` in the
// path and any `:workflowId` belong to a team the caller can see. Workflow
// states are team-owned records, so visibility is by membership (ENG-79).
@Controller({
  version: '1',
  path: ':teamId/workflows',
})
export class WorkflowsController {
  constructor(private workflowsService: WorkflowsService) {}

  @Get()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getAllWorkflows(
    @Param() workflowRequestParams: WorkflowRequestParamsDto,
  ): Promise<Workflow[]> {
    return await this.workflowsService.getAllWorkflows(workflowRequestParams);
  }

  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createWorkflow(
    @Param() workflowRequestParams: WorkflowRequestParamsDto,
    @Body() workflowData: CreateWorkflowDTO,
  ): Promise<Workflow> {
    return await this.workflowsService.createWorkflow(
      workflowRequestParams,
      workflowData,
    );
  }

  @Get(':workflowId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getWorkflow(
    @Param()
    workflowRequestParams: WorkflowRequestParamsDto,
  ): Promise<Workflow> {
    return await this.workflowsService.getWorkflow(workflowRequestParams);
  }

  @Post(':workflowId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateWorkflow(
    @Param()
    workflowRequestParams: WorkflowRequestParamsDto,
    @Body() workflowData: UpdateWorkflowDTO,
  ): Promise<Workflow> {
    return await this.workflowsService.updateWorkflow(
      workflowRequestParams,
      workflowData,
    );
  }

  @Delete(':workflowId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteWorkflow(
    @Param()
    workflowRequestParams: WorkflowRequestParamsDto,
  ): Promise<Workflow> {
    return await this.workflowsService.deleteWorkflow(workflowRequestParams);
  }
}
