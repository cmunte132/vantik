import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { ModelNameEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';
import { Client } from 'pg';
import {
  LogicalReplicationService,
  Pgoutput,
  PgoutputPlugin,
} from 'pg-logical-replication';
import { v4 as uuidv4 } from 'uuid';

import { announcementRoom } from 'common/team-access';

import { IntegrationEventsService } from 'modules/integration-events/integration-events.service';
import { LoggerService } from 'modules/logger/logger.service';
import { SyncGateway } from 'modules/sync/sync.gateway';
import SyncActionsService from 'modules/sync-actions/sync-actions.service';
import { getWorkspaceId } from 'modules/sync-actions/sync-actions.utils';
import { SyncRepairService } from 'modules/sync-actions/sync-repair.service';

import {
  tablesToSendMessagesFor,
  tablesToTrigger,
} from './replication.interface';

// pgoutput is postgres' built-in logical decoder, so any stock postgres
// image works — no wal2json extension required.
const REPLICATION_SLOT_PLUGIN = 'pgoutput';
const PUBLICATION_NAME = 'vantik_publication';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const ignoreError = (): void => undefined;

const tracer = trace.getTracer('vantik-replication');

@Injectable()
export default class ReplicationService implements OnModuleDestroy {
  client: Client;
  private readonly logger: LoggerService = new LoggerService(
    'ReplicationService',
  );
  private replicationSlotName = `vantik_replication_slot_${uuidv4().replace(/-/g, '')}`;
  private service: LogicalReplicationService | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private shuttingDown = false;

  constructor(
    private syncGateway: SyncGateway,
    private syncActionsService: SyncActionsService,
    private integrationEvents: IntegrationEventsService,
    private prisma: PrismaService,
    private syncRepair: SyncRepairService,
  ) {
    this.client = this.createClient();
  }

  private createClient() {
    const client = new Client({
      user: process.env.POSTGRES_USER,
      host: process.env.DB_HOST,
      database: process.env.POSTGRES_DB,
      password: process.env.POSTGRES_PASSWORD,
      port: Number(process.env.DB_PORT) || 5432,
    });
    // Without a handler, a dropped connection is an unhandled 'error' event
    // and it kills the process.
    client.on('error', (error) =>
      this.logger.error({
        message: `Replication control connection failed: ${error}`,
        where: 'ReplicationService.createClient',
        error,
      }),
    );
    return client;
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.service?.destroy().catch(ignoreError);
    this.service = null;
  }

  async init() {
    await this.client.connect();

    await this.deleteOrphanedSlots();
    await this.createReplicationSlot();
    await this.setupReplication();

    // The slot is recreated on every start, so the write-ahead log covering
    // the downtime window is gone before the listener attaches. Anything
    // written in that window produced no sync action, and a record with no
    // sync action never reaches a client. Repairing the log here costs a few
    // queries; the alternative is telling every client to re-bootstrap after
    // every deploy to cover a window that is usually empty.
    //
    // Deliberately not awaited into startup: a slow reconcile should delay
    // clients catching up, not the server accepting requests.
    this.repairSyncLog();
  }

  private repairSyncLog() {
    this.syncRepair.reconcile().catch((error) =>
      this.logger.error({
        message: `Could not repair the sync log after downtime: ${error}`,
        where: 'ReplicationService.repairSyncLog',
        error: error instanceof Error ? error : undefined,
      }),
    );
  }

  async deleteOrphanedSlots() {
    try {
      // Query to find all inactive replication slots
      const findInactiveSlotsQuery = `
        SELECT slot_name
        FROM pg_replication_slots
        WHERE active = false;
      `;

      const result = await this.client.query(findInactiveSlotsQuery);

      // Loop through and delete each inactive slot
      for (const row of result.rows) {
        const slotName = row.slot_name;
        try {
          await this.deleteSlot(slotName);
          this.logger.info({
            message: `Orphaned replication slot ${slotName} deleted successfully.`,
            where: `ReplicationService.deleteOrphanedSlots`,
          });
        } catch (error) {
          this.logger.error({
            message: `Error deleting replication slot ${slotName}:`,
            where: `ReplicationService.deleteOrphanedSlots`,
            error,
          });
        }
      }
    } catch (error) {
      this.logger.error({
        message: 'Error finding or deleting orphaned replication slots:',
        where: `ReplicationService.deleteOrphanedSlots`,
        error,
      });
    }
  }

  async deleteSlot(name: string) {
    try {
      const deleteReplicationSlotQuery = `SELECT pg_drop_replication_slot('${name}')`;

      await this.client.query(deleteReplicationSlotQuery);
    } catch (err) {
      this.logger.error(err);
    }
  }

  async checkForSlot() {
    const checkReplicationSlotQuery = `
    SELECT * FROM pg_replication_slots WHERE slot_name = '${this.replicationSlotName}'
  `;

    const checkSlotResult = await this.client.query(checkReplicationSlotQuery);

    if (checkSlotResult.rows.length > 0) {
      await this.deleteSlot(this.replicationSlotName);
    }
  }

  async ensurePublication() {
    const publicationExists = await this.client.query(
      `SELECT 1 FROM pg_publication WHERE pubname = '${PUBLICATION_NAME}'`,
    );

    if (publicationExists.rows.length === 0) {
      await this.client.query(
        `CREATE PUBLICATION ${PUBLICATION_NAME} FOR ALL TABLES`,
      );
      this.logger.info({
        message: `Publication ${PUBLICATION_NAME} created.`,
        where: `ReplicationService.ensurePublication`,
      });
    }
  }

  async createReplicationSlot() {
    try {
      await this.setReplicaIdentityFull();

      await this.ensurePublication();

      await this.checkForSlot();

      const createReplicationSlotQuery = `
        SELECT * FROM pg_create_logical_replication_slot(
          '${this.replicationSlotName}',
          '${REPLICATION_SLOT_PLUGIN}'
        )
      `;

      // Create replication slot
      const result = await this.client.query(createReplicationSlotQuery);

      this.logger.info({
        message: 'Replication slot created successfully:',
        where: `ReplicationService.createReplicationSlot`,
        payload: { row: result.rows[0] },
      });
    } catch (error) {
      this.logger.error({
        message: 'Error creating replication slot:',
        where: `ReplicationService.createReplicationSlot`,
        error,
      });
    } finally {
      await this.client.end();
    }
  }

  async setReplicaIdentityFull() {
    try {
      await this.prisma.$executeRaw`ALTER TABLE "Issue" REPLICA IDENTITY FULL`;
      await this.prisma
        .$executeRaw`ALTER TABLE "IssueComment" REPLICA IDENTITY FULL`;
      await this.prisma
        .$executeRaw`ALTER TABLE "LinkedIssue" REPLICA IDENTITY FULL`;

      this.logger.info({
        message: 'REPLICA IDENTITY FULL set for all specified tables.',
        where: `ReplicationService.setReplicaIdentityFull`,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error setting REPLICA IDENTITY FULL:',
        where: `ReplicationService.setReplicaIdentityFull`,
        error,
      });
    }
  }

  // Retry with capped exponential backoff. Calls from a stream that was
  // already replaced, or while a retry is queued or running, do nothing.
  private scheduleReconnect(from: LogicalReplicationService) {
    if (
      this.shuttingDown ||
      from !== this.service ||
      this.reconnectTimer ||
      this.reconnecting
    ) {
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.logger.info({
      message: `Reconnecting replication in ${delay}ms`,
      where: 'ReplicationService.scheduleReconnect',
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  async reconnect() {
    if (this.shuttingDown) {
      return;
    }
    this.reconnecting = true;
    const old = this.service;
    try {
      // destroy() ends the old client and removes our listeners, so the old
      // stream cannot report a second failure or deliver duplicate changes.
      await old?.destroy().catch(ignoreError);
      const recreated = await this.ensureSlotExists();
      if (this.shuttingDown) {
        return;
      }
      this.setupReplication();
      // A new slot starts at the current log position, so changes made while
      // the old slot was gone need the same repair as after a restart.
      if (recreated) {
        this.repairSyncLog();
      }
    } catch (error) {
      this.logger.error({
        message: `Could not reconnect replication: ${error}`,
        where: 'ReplicationService.reconnect',
        error: error instanceof Error ? error : undefined,
      });
      this.reconnecting = false;
      if (old) {
        this.scheduleReconnect(old);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  // Keeps the existing slot when it is still there. Returns true when it had
  // to create a new one, the same way startup does.
  private async ensureSlotExists() {
    this.client = this.createClient();
    await this.client.connect();
    try {
      await this.ensurePublication();
      const existing = await this.client.query(
        `SELECT 1 FROM pg_replication_slots WHERE slot_name = '${this.replicationSlotName}'`,
      );
      if (existing.rows.length > 0) {
        return false;
      }
      await this.client.query(
        `SELECT * FROM pg_create_logical_replication_slot('${this.replicationSlotName}', '${REPLICATION_SLOT_PLUGIN}')`,
      );
      this.logger.info({
        message: 'Replication slot recreated',
        where: 'ReplicationService.ensureSlotExists',
      });
      return true;
    } finally {
      await this.client.end().catch(ignoreError);
    }
  }

  getChangedData(log: Pgoutput.MessageInsert | Pgoutput.MessageUpdate) {
    // eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style, @typescript-eslint/no-explicit-any
    const changedData: { [key: string]: any } = {};
    const newRow = log.new ?? {};
    const oldRow = (log.tag === 'update' ? log.old : null) ?? {};

    // Values are decoded (dates, json, arrays...), so normalise before
    // comparing to avoid reporting identical objects as changes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normalise = (value: any) =>
      value instanceof Object ? JSON.stringify(value) : value;

    Object.keys(newRow).forEach((columnName) => {
      const oldValue = oldRow[columnName];
      const newValue = newRow[columnName];

      if (normalise(oldValue) !== normalise(newValue) && newValue !== null) {
        changedData[columnName] = newValue;
      }
    });

    return changedData;
  }

  async setupReplication() {
    const dbSchema = process.env.DB_SCHEMA;
    const clientConfig = {
      host: process.env.DB_HOST,
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      port: Number(process.env.DB_PORT) || 5432,
    };
    this.startStream(clientConfig, dbSchema);
  }

  private startStream(
    clientConfig: {
      host?: string;
      database?: string;
      user?: string;
      password?: string;
      port: number;
    },
    dbSchema: string | undefined,
  ) {
    const service = new LogicalReplicationService(clientConfig);
    this.service = service;
    const plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [PUBLICATION_NAME],
    });

    // The library re-emits connection errors here. Log them and reconnect.
    service.on('error', (error: Error) => {
      this.logger.error({
        message: `Replication stream failed: ${error}`,
        where: 'ReplicationService.startStream',
        error,
      });
      this.scheduleReconnect(service);
    });

    service.on('start', () => {
      this.reconnectAttempt = 0;
      this.logger.info({
        message: 'Replication server connected',
        where: `ReplicationService.startStream`,
      });
    });

    // subscribe() settles only when the stream ends, so a settled promise
    // while we are still running means the connection dropped.
    service
      .subscribe(plugin, this.replicationSlotName)
      .catch((e) => {
        this.logger.error(e);
      })
      .then(() => this.scheduleReconnect(service));

    service.on('data', async (_lsn: string, log: Pgoutput.Message) => {
      // pgoutput emits one event per message (begin/commit/relation/DML).
      if (
        log.tag !== 'insert' &&
        log.tag !== 'update' &&
        log.tag !== 'delete'
      ) {
        return;
      }

      if (log.relation.schema !== dbSchema) {
        return;
      }

      const modelName = log.relation.name as ModelNameEnum;
      const sendsMessages = tablesToSendMessagesFor.has(modelName);
      const triggersIntegrations = tablesToTrigger.has(modelName);
      if (!sendsMessages && !triggersIntegrations) {
        return;
      }

      // A physical delete carries no new row — the id comes from the replica
      // identity instead. These used to be dropped on the grounds that the app
      // soft-deletes, which is true of the app's own write paths and of nothing
      // else: cascades, retention jobs, event trimming, a workspace deletion,
      // an operator fixing data by hand. Every one of those left the row in
      // each connected client's cache permanently, because the only thing that
      // ever removes a cached row is a delete action, and none was written.
      // A stale row is not inert either: it is clickable, and it opens a page
      // for something the server will 404.
      const newRow =
        (log.tag === 'delete' ? (log.key ?? log.old) : log.new) ?? {};
      const isDeleted = log.tag === 'delete' || !!newRow.deleted;
      const modelId = newRow.id;

      if (!modelId) {
        // Without a replica identity there is no id to tell anyone about. Say
        // so once per table rather than failing silently, since the fix is a
        // schema change on the server.
        this.logger.error({
          message: `A ${log.tag} on ${modelName} carried no id; clients cannot be told about it. Set REPLICA IDENTITY on that table.`,
          where: `ReplicationService.setupReplication`,
        });
        return;
      }

      // One span for each change. Without it, each Prisma query of the sync
      // work starts its own trace, and the traces of one change do not join.
      await tracer.startActiveSpan(
        `replicate ${modelName} ${log.tag}`,
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            'db.collection.name': modelName,
            'vantik.replication.operation': log.tag,
          },
        },
        async (span) => {
          try {
            if (sendsMessages) {
              const syncActionData =
                await this.syncActionsService.upsertSyncAction(
                  _lsn,
                  isDeleted ? 'delete' : log.tag,
                  modelName,
                  modelId,
                );

              // Nothing to announce: a record deleted before any client was ever
              // told it existed.
              if (!syncActionData) {
                return;
              }

              // Three models belong to one person and go to that person's own room.
              // Everything else goes to the room of the team that owns it, and to the
              // workspace room when no team does. Before this, one room held every
              // member of the workspace, so a change to any issue of any team reached
              // all of them (ENG-79).
              const recipientId = [
                ModelNameEnum.Notification,
                ModelNameEnum.Conversation,
                ModelNameEnum.ConversationHistory,
              ].includes(modelName)
                ? (syncActionData.data.recipientId ??
                  syncActionData.data.userId)
                : announcementRoom(
                    syncActionData.workspaceId,
                    syncActionData.teamId,
                  );

              this.syncGateway.wss
                .to(recipientId)
                .emit('message', JSON.stringify(syncActionData));
            }

            // Physical deletes are deliberately not handed to integrations: the
            // event's workspace is resolved by reading the record, which no longer
            // exists. Soft deletes still arrive here, as a `delete` tag no plugin
            // subscribes to, which is every delete the app itself performs.
            if (triggersIntegrations && log.tag !== 'delete') {
              const changedData = this.getChangedData(log);

              const workspaceId = await getWorkspaceId(
                this.prisma,
                modelName,
                modelId,
              );

              await this.integrationEvents.recordChanged({
                modelName,
                modelId,
                tag: isDeleted ? 'delete' : log.tag,
                changedData,
                workspaceId,
                lsn: _lsn,
              });
            }
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    });
  }
}
