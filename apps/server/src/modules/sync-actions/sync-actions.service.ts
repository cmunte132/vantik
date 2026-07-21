import { Injectable } from '@nestjs/common';
import { ModelName } from '@prisma/client';
import { ModelNameEnum, SyncAction } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import {
  convertLsnToInt,
  convertToActionType,
  getLastSequenceId,
  getModelData,
  getSyncActionsData,
  getWorkspaceId,
} from './sync-actions.utils';

@Injectable()
export default class SyncActionsService {
  constructor(private prisma: PrismaService) {}
  async upsertSyncAction(
    lsn: string,
    action: string,
    modelName: ModelNameEnum,
    modelId: string,
  ) {
    const workspaceId = await getWorkspaceId(this.prisma, modelName, modelId);
    const sequenceId = convertLsnToInt(lsn);
    const actionType = convertToActionType(action);

    const syncActionData = await this.prisma.syncAction.upsert({
      where: {
        modelId_action: {
          modelId,
          action: actionType,
        },
      },
      update: {
        sequenceId,
        action: actionType,
      },
      create: {
        action: actionType,
        modelName: modelName as ModelName,
        modelId,
        workspaceId,
        sequenceId,
      },
    });

    const modelData = await getModelData(this.prisma, modelName, modelId);

    return {
      data: modelData,
      ...syncActionData,
    };
  }

  async getBootstrap(
    modelNames: string,
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId?: string,
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    // One row per model, and it has to be the *latest* one. A soft delete
    // leaves both an 'I' and a 'D' row for the same modelId (upsertSyncAction
    // keys on modelId+action), so deduplicating in ascending order keeps the
    // insert and discards the delete — the bootstrap then hands a deleted
    // record back to the client as an insert. Those resurrected rows are
    // undeletable: the client shows them, but every write against them 404s at
    // WorkspaceResourceGuard, which only matches `deleted: null`.
    const latestPerModel = await this.prisma.syncAction.findMany({
      where: {
        workspaceId,
        modelName: { in: modelNames.split(',') as ModelName[] },
      },
      orderBy: {
        sequenceId: 'desc',
      },
      distinct: ['modelId'],
    });

    // A bootstrap describes the world as it stands, so deleted records are
    // dropped rather than sent as deletes. Applied oldest first, as the client
    // expects.
    const syncActions = latestPerModel
      .filter((action) => action.action !== 'D')
      .reverse();

    return {
      syncActions: await getSyncActionsData(
        this.prisma,
        syncActions as SyncAction[],
        userId,
      ),
      lastSequenceId: await getLastSequenceId(this.prisma, workspaceId),
    };
  }

  async getDelta(
    modelNames: string,
    lastSequenceId: bigint,
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId?: string,
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    const syncActions = await this.prisma.syncAction.findMany({
      where: {
        workspaceId,
        sequenceId: { gt: lastSequenceId },
        modelName: { in: modelNames.split(',') as ModelName[] },
      },
      orderBy: {
        sequenceId: 'asc',
      },
      distinct: ['modelId', 'modelName', 'workspaceId', 'action'],
    });

    return {
      syncActions: await getSyncActionsData(
        this.prisma,
        syncActions as SyncAction[],
        userId,
      ),
      lastSequenceId: await getLastSequenceId(this.prisma, workspaceId),
    };
  }
}
