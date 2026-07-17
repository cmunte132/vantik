import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelNameEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';
import { Client } from 'pg';
import {
  LogicalReplicationService,
  Pgoutput,
  PgoutputPlugin,
} from 'pg-logical-replication';
import { v4 as uuidv4 } from 'uuid';

import ActionEventService from 'modules/action-event/action-event.service';
import { LoggerService } from 'modules/logger/logger.service';
import { SyncGateway } from 'modules/sync/sync.gateway';
import SyncActionsService from 'modules/sync-actions/sync-actions.service';
import { getWorkspaceId } from 'modules/sync-actions/sync-actions.utils';

import {
  tablesToSendMessagesFor,
  tablesToTrigger,
} from './replication.interface';

// pgoutput is postgres' built-in logical decoder, so any stock postgres
// image works — no wal2json extension required.
const REPLICATION_SLOT_PLUGIN = 'pgoutput';
const PUBLICATION_NAME = 'vantik_publication';

@Injectable()
export default class ReplicationService {
  client: Client;
  private readonly logger: LoggerService = new LoggerService(
    'ReplicationService',
  );
  private replicationSlotName = `vantik_replication_slot_${uuidv4().replace(/-/g, '')}`;

  constructor(
    private configService: ConfigService,
    private syncGateway: SyncGateway,
    private syncActionsService: SyncActionsService,
    private actionEventService: ActionEventService,
    private prisma: PrismaService,
  ) {
    this.client = new Client({
      user: configService.get('POSTGRES_USER'),
      host: configService.get('DB_HOST'),
      database: configService.get('POSTGRES_DB'),
      password: configService.get('POSTGRES_PASSWORD'),
      port: configService.get('DB_PORT'),
    });
  }

  async init() {
    await this.client.connect();

    await this.deleteOrphanedSlots();
    await this.createReplicationSlot();
    await this.setupReplication();
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
    const dbSchema = this.configService.get('DB_SCHEMA');
    const clientConfig = {
      host: this.configService.get('DB_HOST'),
      database: this.configService.get('POSTGRES_DB'),
      user: this.configService.get('POSTGRES_USER'),
      password: this.configService.get('POSTGRES_PASSWORD'),
      port: this.configService.get('DB_PORT'),
    };
    const service = new LogicalReplicationService(clientConfig);
    const plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [PUBLICATION_NAME],
    });
    service
      .subscribe(plugin, this.replicationSlotName)
      .catch((e) => {
        this.logger.error(e);
      })
      .then(() => {
        this.logger.info({
          message: 'Replication server connected',
          where: `ReplicationService.setupReplication`,
        });
      });

    service.on('data', async (_lsn: string, log: Pgoutput.Message) => {
      // pgoutput emits one event per message (begin/commit/relation/DML);
      // deletes are ignored because the app soft-deletes via the `deleted` column
      if (log.tag !== 'insert' && log.tag !== 'update') {
        return;
      }

      if (log.relation.schema !== dbSchema) {
        return;
      }

      const modelName = log.relation.name as ModelNameEnum;
      const newRow = log.new ?? {};
      const isDeleted = !!newRow.deleted;
      const modelId = newRow.id;

      if (tablesToSendMessagesFor.has(modelName)) {
        const syncActionData = await this.syncActionsService.upsertSyncAction(
          _lsn,
          isDeleted ? 'delete' : log.tag,
          modelName,
          modelId,
        );

        const recipientId = [
          ModelNameEnum.Notification,
          ModelNameEnum.Conversation,
          ModelNameEnum.ConversationHistory,
        ].includes(modelName)
          ? (syncActionData.data.recipientId ?? syncActionData.data.userId)
          : syncActionData.workspaceId;

        this.syncGateway.wss
          .to(recipientId)
          .emit('message', JSON.stringify(syncActionData));
      }

      if (tablesToTrigger.has(modelName)) {
        const changedData = this.getChangedData(log);

        const workspaceId = await getWorkspaceId(this.prisma, modelName, modelId);

        await this.actionEventService.createEvent({
          modelName,
          modelId,
          eventType: isDeleted ? 'delete' : log.tag,
          eventData: changedData,
          workspaceId,
          sequenceId: _lsn,
        });
      }
    });
  }
}
