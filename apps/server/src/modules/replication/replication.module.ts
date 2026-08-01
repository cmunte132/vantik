import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';

import { ActionEventModule } from 'modules/action-event/action-event.module';
import ActionEventService from 'modules/action-event/action-event.service';
import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { SyncModule } from 'modules/sync/sync.module';
import SyncActionsService from 'modules/sync-actions/sync-actions.service';
import { SyncRepairService } from 'modules/sync-actions/sync-repair.service';

import ReplicationService from './replication.service';

@Module({
  // ActionEventModule because ActionEventService is provided below rather than
  // imported, and it now dispatches onto the actions queue.
  imports: [SyncModule, IntegrationsModule, ActionEventModule],
  controllers: [],
  providers: [
    ReplicationService,
    ConfigService,
    SyncActionsService,
    SyncRepairService,
    PrismaService,
    ActionEventService,
  ],
  exports: [],
})
export class ReplicationModule {}
