import { Injectable } from '@nestjs/common';
import { ModelNameEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { tablesToSendMessagesFor } from '../replication/replication.interface';

/** Rows examined per model before giving up and saying so. */
const SCAN_LIMIT = 20_000;

/** Ids checked for existence in one query. */
const EXISTENCE_BATCH = 500;

interface RepairSummary {
  changesRecovered: number;
  deletesRecovered: number;
  modelsSkipped: string[];
}

/**
 * Repairs the sync log for changes made while nobody was listening.
 *
 * The replication slot is dropped and recreated on every server start
 * (`checkForSlot`), so the write-ahead log from the downtime window is gone
 * before the listener attaches. Anything written during that window — by a
 * second instance, a migration, an operator, a restore — produces no sync
 * action, and a record with no sync action is invisible to every client
 * forever. Not eventually: forever, because the only thing that reaches a
 * client is a sync action with a sequence higher than the one it holds.
 *
 * The alternative to repairing is to invalidate: bump an epoch and make every
 * client re-bootstrap after each restart. That is correct and enormous — a
 * full workspace payload per client per deploy, to cover a window that is
 * usually empty. Repairing costs a handful of queries at boot and leaves the
 * incremental path intact.
 *
 * What cannot be recovered this way is a record that was created *and* deleted
 * inside the downtime window. No client ever saw it, so there is nothing to
 * correct.
 */
@Injectable()
export class SyncRepairService {
  private readonly logger = new LoggerService('SyncRepairService');

  constructor(private prisma: PrismaService) {}

  async reconcile(): Promise<RepairSummary> {
    const summary: RepairSummary = {
      changesRecovered: 0,
      deletesRecovered: 0,
      modelsSkipped: [],
    };

    const newest = await this.prisma.syncAction.aggregate({
      _max: { createdAt: true, sequenceId: true },
    });

    // An empty log means no client has ever been told anything, so there is
    // nothing to be out of step with. Bootstrap covers this case.
    if (!newest._max.createdAt) {
      return summary;
    }

    const cutoff = newest._max.createdAt;
    let sequence = nextSequence(newest._max.sequenceId);

    for (const modelName of tablesToSendMessagesFor.keys()) {
      const delegate = this.delegateFor(modelName);

      if (!delegate?.findMany) {
        summary.modelsSkipped.push(modelName);
        continue;
      }

      try {
        const changed = await this.changedSince(delegate, cutoff);

        for (const row of changed) {
          const recorded = await this.record(
            sequence++,
            row.deleted ? 'D' : 'U',
            modelName,
            row.id,
          );

          // Only count what was actually written. A record created during the
          // downtime window was never announced to anyone, so there is nothing
          // to correct — counting it would report repairs that did not happen.
          summary.changesRecovered += recorded ? 1 : 0;
        }

        const vanished = await this.vanishedSince(delegate, modelName);

        for (const modelId of vanished) {
          const recorded = await this.record(sequence++, 'D', modelName, modelId);
          summary.deletesRecovered += recorded ? 1 : 0;
        }
      } catch (error) {
        // One awkward model must not stop the rest: a partial repair is
        // strictly better than none, and the name is logged so it can be
        // fixed rather than silently tolerated.
        summary.modelsSkipped.push(modelName);
        this.logger.error({
          message: `Could not reconcile ${modelName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          where: 'SyncRepairService.reconcile',
        });
      }
    }

    if (summary.changesRecovered || summary.deletesRecovered) {
      this.logger.info({
        message:
          `Repaired the sync log after downtime: ${summary.changesRecovered} ` +
          `changes and ${summary.deletesRecovered} deletions that clients ` +
          'would otherwise never have heard about.',
        where: 'SyncRepairService.reconcile',
      });
    }

    return summary;
  }

  /**
   * Rows written after the newest thing the log knows about.
   *
   * `updatedAt` rather than a sequence, because the point is precisely that
   * these changes never got a sequence. Over-scanning is harmless: writing a
   * sync action for a record whose action is already current is an upsert that
   * changes nothing but the sequence, and the client applies an identical
   * record.
   */
  private async changedSince(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delegate: any,
    cutoff: Date,
  ): Promise<Array<{ id: string; deleted?: Date | null }>> {
    try {
      return await delegate.findMany({
        where: { updatedAt: { gt: cutoff } },
        select: { id: true, deleted: true },
        take: SCAN_LIMIT,
      });
    } catch {
      // Not every synced model carries `deleted`; those cannot be soft-deleted
      // and so are always a plain update.
      return await delegate.findMany({
        where: { updatedAt: { gt: cutoff } },
        select: { id: true },
        take: SCAN_LIMIT,
      });
    }
  }

  /**
   * Records the log says exist but which are no longer in the table.
   *
   * A physical delete during downtime leaves the sync log claiming the record
   * is alive, and every client that cached it agrees. Comparing the two is the
   * only way to find those, since the row itself is gone.
   */
  private async vanishedSince(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delegate: any,
    modelName: ModelNameEnum,
  ): Promise<string[]> {
    const announced = await this.prisma.syncAction.findMany({
      where: { modelName: modelName as never, action: { not: 'D' } },
      select: { modelId: true },
      take: SCAN_LIMIT,
    });

    const vanished: string[] = [];

    for (let index = 0; index < announced.length; index += EXISTENCE_BATCH) {
      const batch = announced
        .slice(index, index + EXISTENCE_BATCH)
        .map((row) => row.modelId);

      const alive = await delegate.findMany({
        where: { id: { in: batch } },
        select: { id: true },
      });

      const aliveIds = new Set(alive.map((row: { id: string }) => row.id));

      vanished.push(...batch.filter((id) => !aliveIds.has(id)));
    }

    return vanished;
  }

  /**
   * Writes a repaired action into the log.
   *
   * The workspace comes from whatever the log already holds for this record —
   * the same reasoning as a live delete: it is the only place that still knows
   * once the row is gone, and a record nobody was ever told about needs no
   * correction.
   */
  private async record(
    sequenceId: bigint,
    action: 'U' | 'D',
    modelName: ModelNameEnum,
    modelId: string,
  ): Promise<boolean> {
    const announced = await this.prisma.syncAction.findFirst({
      where: { modelId, modelName: modelName as never },
      select: { workspaceId: true },
    });

    if (!announced) {
      return false;
    }

    await this.prisma.syncAction.upsert({
      where: { modelId_action: { modelId, action } },
      update: { sequenceId },
      create: {
        action,
        modelName: modelName as never,
        modelId,
        workspaceId: announced.workspaceId,
        sequenceId,
      },
    });

    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private delegateFor(modelName: ModelNameEnum): any {
    // Prisma delegates are the model name with a lowercased first letter.
    const property = modelName.charAt(0).toLowerCase() + modelName.slice(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any)[property];
  }
}

/**
 * The first sequence a repair may claim.
 *
 * Sequences are `now() * 1000 + lsn % 1000`, so they are wall-clock ordered
 * rather than WAL-ordered. A repair therefore takes ids from the current
 * instant, which sits above everything already recorded and below everything
 * replication will record next — and above the newest existing id even if the
 * clock has not moved since.
 */
export function nextSequence(highest: bigint | null): bigint {
  const now = BigInt(Date.now()) * 1000n;

  return highest && highest >= now ? highest + 1n : now;
}
