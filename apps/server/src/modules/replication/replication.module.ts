import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IntegrationEventsModule } from 'modules/integration-events/integration-events.module';
import { SyncModule } from 'modules/sync/sync.module';
import SyncActionsService from 'modules/sync-actions/sync-actions.service';
import { SyncRepairService } from 'modules/sync-actions/sync-repair.service';

import ReplicationService from './replication.service';

@Module({
  imports: [SyncModule, IntegrationEventsModule],
  controllers: [],
  providers: [
    ReplicationService,
    ConfigService,
    SyncActionsService,
    SyncRepairService,
  ],
  exports: [],
})
export class ReplicationModule {}
