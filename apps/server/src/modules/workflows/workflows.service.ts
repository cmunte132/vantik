import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  CreateWorkflowDTO,
  TeamRequestParamsDto,
  UpdateWorkflowDTO,
  Workflow,
  WorkflowRequestParamsDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

@Injectable()
export default class WorkflowsService {
  constructor(private prisma: PrismaService) {}
  private readonly logger = new LoggerService(WorkflowsService.name);

  async getAllWorkflows(
    workflowRequestParams: WorkflowRequestParamsDto,
  ): Promise<Workflow[]> {
    this.logger.debug({
      message: `Fetching all workflows for team ${workflowRequestParams.teamId}`,
      where: `WorkflowsService.getAllWorkflows`,
    });

    return await this.prisma.workflow.findMany({
      where: {
        teamId: workflowRequestParams.teamId,
      },
    });
  }

  async getWorkflow(
    workflowRequestParams: WorkflowRequestParamsDto,
  ): Promise<Workflow> {
    this.logger.debug({
      message: `Fetching workflow with id ${workflowRequestParams.workflowId}`,
      where: `WorkflowsService.getWorkflow`,
    });

    return await this.prisma.workflow.findUnique({
      where: {
        id: workflowRequestParams.workflowId,
      },
    });
  }

  async createWorkflow(
    workflowRequestParams: TeamRequestParamsDto,
    workflowData: CreateWorkflowDTO,
  ): Promise<Workflow> {
    this.logger.debug({
      message: `Creating new workflow for team ${workflowRequestParams.teamId}`,
      payload: { teamId: workflowRequestParams.teamId, workflowData },
      where: `WorkflowsService.createWorkflow`,
    });

    try {
      // Field by field, because the global ValidationPipe keeps undeclared
      // keys: spreading the body after `teamId` let a `teamId` in the body
      // decide which team the state landed in.
      return await this.prisma.workflow.create({
        data: {
          teamId: workflowRequestParams.teamId,
          name: workflowData.name,
          description: workflowData.description,
          position: workflowData.position,
          color: workflowData.color,
          category: workflowData.category,
        },
      });
    } catch (error) {
      this.logger.error({
        message: `Error while creating workflow`,
        where: `WorkflowsService.createWorkflow`,
        error,
        payload: workflowData,
      });
      if (error.name === 'PrismaClientKnownRequestError') {
        throw new BadRequestException(
          'A workflow state with this name and type already exists for this team',
        );
      }
      throw new InternalServerErrorException(
        error,
        `Error while creating workflow`,
      );
    }
  }

  async updateWorkflow(
    workflowRequestParams: WorkflowRequestParamsDto,
    workflowData: UpdateWorkflowDTO,
  ): Promise<Workflow> {
    this.logger.debug({
      message: `Updating workflow with id ${workflowRequestParams.workflowId}`,
      payload: { workflowId: workflowRequestParams.workflowId, workflowData },
      where: `WorkflowsService.updateWorkflow`,
    });

    try {
      return await this.prisma.workflow.update({
        data: {
          name: workflowData.name,
          description: workflowData.description,
          position: workflowData.position,
          color: workflowData.color,
          category: workflowData.category,
        },
        where: {
          id: workflowRequestParams.workflowId,
        },
      });
    } catch (error) {
      this.logger.error({
        message: `Error while updating workflow`,
        where: `WorkflowsService.updateWorkflow`,
        error,
        payload: workflowData,
      });
      if (error.name === 'PrismaClientKnownRequestError') {
        throw new BadRequestException(
          'A workflow state with this name and type already exists for this team',
        );
      }
      throw new InternalServerErrorException(
        error,
        `Error while creating workflow`,
      );
    }
  }

  async deleteWorkflow(
    workflowRequestParams: WorkflowRequestParamsDto,
  ): Promise<Workflow> {
    this.logger.debug({
      message: `Deleting workflow with id ${workflowRequestParams.workflowId}`,
      where: `WorkflowsService.deleteWorkflow`,
    });

    return await this.prisma.workflow.update({
      where: {
        id: workflowRequestParams.workflowId,
      },
      data: {
        deleted: new Date().toISOString(),
      },
    });
  }
}
