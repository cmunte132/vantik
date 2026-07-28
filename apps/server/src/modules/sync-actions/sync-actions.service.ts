import { Injectable } from '@nestjs/common';
import { ModelName } from '@prisma/client';
import { ModelNameEnum, SyncAction } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { syncActionTeamWhere, visibleTeamIds } from 'common/team-access';
import { resolveWorkspaceId } from 'common/workspace-access';

import {
  convertLsnToInt,
  convertToActionType,
  getLastSequenceId,
  getModelData,
  getSyncActionsData,
  getTeamId,
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
    const sequenceId = convertLsnToInt(lsn);
    const actionType = convertToActionType(action);

    // A physically deleted row cannot be read to find out whose it was, so the
    // workspace comes from the sync log's own memory of it. Every model a
    // client caches was announced to that client at least once, and that
    // announcement recorded the workspace — which makes the log the one place
    // that still knows after the row is gone.
    const workspaceId =
      actionType === 'D'
        ? await this.workspaceOfDeleted(modelName, modelId)
        : await getWorkspaceId(this.prisma, modelName, modelId);

    // Nothing was ever announced, so no client has it and there is nobody to
    // tell. Writing a delete for it would only add a row nobody can act on.
    if (!workspaceId) {
      return undefined;
    }

    // The team is recorded for the same reason the workspace is, and it is
    // recovered the same way after a physical delete: the row is gone, so the
    // only place that still knows which team owned it is the announcement that
    // named it while it existed.
    const teamId =
      actionType === 'D'
        ? await this.teamOfDeleted(modelName, modelId)
        : await getTeamId(this.prisma, modelName, modelId);

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
        // A record moves between teams: `moveIssue` is a supported operation,
        // and the issues that hang off it move with it. The announcement has
        // to follow, or the delta keeps serving the issue to the old team.
        teamId: teamId ?? null,
      },
      create: {
        action: actionType,
        modelName: modelName as ModelName,
        modelId,
        workspaceId,
        teamId: teamId ?? null,
        sequenceId,
      },
    });

    // A deleted row has no data to read. The client needs only the id to evict
    // it, and every save handler reads `record.data.id`, so that is what a
    // delete carries.
    const modelData =
      actionType === 'D'
        ? ((await getModelData(this.prisma, modelName, modelId)) ?? {
            id: modelId,
          })
        : await getModelData(this.prisma, modelName, modelId);

    return {
      data: modelData,
      ...syncActionData,
    };
  }

  /**
   * The workspace a now-deleted record belonged to.
   *
   * Read from the sync log rather than the record, because the record is gone
   * by the time a delete is processed.
   */
  private async workspaceOfDeleted(
    modelName: ModelNameEnum,
    modelId: string,
  ): Promise<string | undefined> {
    const announced = await this.prisma.syncAction.findFirst({
      where: { modelId, modelName: modelName as ModelName },
      select: { workspaceId: true },
    });

    return announced?.workspaceId;
  }

  /**
   * The team a now-deleted record belonged to.
   *
   * Read from the sync log, for the same reason as the workspace above. The
   * announcement that named the record while it existed is the last thing that
   * knows which team owned it.
   *
   * The insert and the update announcements are searched, and not the delete
   * that is being written: a delete row carries whatever a previous pass put
   * on it, which for a record announced before this column existed is nothing.
   */
  private async teamOfDeleted(
    modelName: ModelNameEnum,
    modelId: string,
  ): Promise<string | undefined> {
    const announced = await this.prisma.syncAction.findFirst({
      where: {
        modelId,
        modelName: modelName as ModelName,
        action: { not: 'D' },
        teamId: { not: null },
      },
      select: { teamId: true },
    });

    return announced?.teamId ?? undefined;
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
    // A team is a visibility boundary (ENG-79), and this is one of the two
    // reads that decide what a client holds. Filtering the screens instead
    // would hide nothing: the record would already sit in the client's own
    // IndexedDB, whatever the screen drew.
    const teamIds = await visibleTeamIds(this.prisma, userId, workspaceId);

    const latestPerModel = await this.prisma.syncAction.findMany({
      where: {
        workspaceId,
        modelName: { in: modelNames.split(',') as ModelName[] },
        ...syncActionTeamWhere(teamIds),
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

    const currentSequenceId = await getLastSequenceId(this.prisma, workspaceId);

    // A client cannot legitimately be ahead of the server. When it is, its
    // history belongs to a database this one is not — a restore, a workspace
    // copied between environments, or a stale sequence surviving a reset — and
    // every delta from here would be empty while the cache quietly stays
    // wrong. Say so, rather than answering a question that has no true answer.
    if (lastSequenceId > currentSequenceId) {
      return {
        resync: true,
        syncActions: [] as SyncAction[],
        lastSequenceId: currentSequenceId,
      };
    }

    // The same boundary as the bootstrap. A client that was given nothing for
    // a team must not be given the changes to it either.
    const teamIds = await visibleTeamIds(this.prisma, userId, workspaceId);

    const syncActions = await this.prisma.syncAction.findMany({
      where: {
        workspaceId,
        sequenceId: { gt: lastSequenceId },
        modelName: { in: modelNames.split(',') as ModelName[] },
        ...syncActionTeamWhere(teamIds),
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
      lastSequenceId: currentSequenceId,
    };
  }
}
