import { Injectable } from '@nestjs/common';
import {
  CreateLabelDto,
  Label,
  LabelRequestParamsDto,
  UpdateLabelDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import {
  assertTeamInWorkspace,
  resolveWorkspaceId,
} from 'common/workspace-access';

import { RequestIdParams } from './labels.interface';

@Injectable()
export default class LabelsService {
  constructor(private prisma: PrismaService) {}

  /**
   * The body names the workspace the label lands in, and that name is honoured
   * only once the caller is shown to be a member of it. Before, it was written
   * as sent, so any signed-in caller could plant labels in any workspace.
   *
   * The fields are copied one by one rather than spread, because the global
   * ValidationPipe does not strip keys the DTO does not declare.
   */
  async createLabel(
    labelData: CreateLabelDto,
    userId: string,
    sessionWorkspaceId: string,
  ): Promise<Label> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      labelData.workspaceId,
    );

    // The guard proved the team against the session's workspace, which is not
    // always the one the body names.
    if (labelData.teamId) {
      await assertTeamInWorkspace(this.prisma, labelData.teamId, workspaceId);
    }

    return await this.prisma.label.upsert({
      where: {
        name_workspaceId: { name: labelData.name, workspaceId },
      },
      update: { deleted: null, name: labelData.name, color: labelData.color },
      create: {
        name: labelData.name,
        color: labelData.color,
        description: labelData.description,
        groupId: labelData.groupId,
        teamId: labelData.teamId,
        workspaceId,
      },
    });
  }

  /**
   * Every label of one workspace the caller belongs to.
   *
   * This used to match `workspaceId OR teamId`, and Prisma drops an undefined
   * side, so a request without a workspace matched every label on the server.
   * A team's labels carry its workspace too, so the workspace alone returns
   * everything the old filter did for a well-formed request.
   */
  async getAllLabels(
    requestIdParams: RequestIdParams,
    userId: string,
    sessionWorkspaceId: string,
  ): Promise<Label[]> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestIdParams.workspaceId,
    );

    return await this.prisma.label.findMany({
      where: { workspaceId },
    });
  }

  async updateLabel(
    LabelRequestIdParams: LabelRequestParamsDto,
    labelData: UpdateLabelDto,
  ): Promise<Label> {
    return await this.prisma.label.update({
      data: {
        name: labelData.name,
        color: labelData.color,
        description: labelData.description,
        groupId: labelData.groupId,
      },
      where: {
        id: LabelRequestIdParams.labelId,
      },
    });
  }

  async deleteLabel(labelRequestIdParams: LabelRequestParamsDto) {
    const label = await this.prisma.label.update({
      where: {
        id: labelRequestIdParams.labelId,
      },
      data: {
        deleted: new Date().toISOString(),
      },
    });

    await this.prisma.$executeRaw`
      UPDATE "Issue"
      SET "labelIds" = array_remove("labelIds", ${labelRequestIdParams.labelId})
      WHERE ${labelRequestIdParams.labelId} = ANY("labelIds")
    `;

    await this.prisma.$executeRaw`
    UPDATE "IssueHistory"
    SET "addedLabelIds" = array_remove("addedLabelIds", ${labelRequestIdParams.labelId}), 
    "removedLabelIds" = array_remove("removedLabelIds", ${labelRequestIdParams.labelId})
    WHERE ${labelRequestIdParams.labelId} = ANY("addedLabelIds") or ${labelRequestIdParams.labelId} = ANY("removedLabelIds")
    `;

    return label;
  }
}
