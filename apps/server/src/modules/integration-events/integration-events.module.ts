import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { IntegrationsModule } from 'modules/integrations/integrations.module';

import { INTEGRATION_EVENTS_QUEUE } from './integration-events.interface';
import { IntegrationEventsProcessor } from './integration-events.processor';
import { IntegrationEventsService } from './integration-events.service';

@Module({
  imports: [
    IntegrationsModule,
    BullModule.registerQueue({ name: INTEGRATION_EVENTS_QUEUE }),
  ],
  providers: [IntegrationEventsService, IntegrationEventsProcessor],
  // Replication and the webhook receiver are what see an event happen.
  exports: [IntegrationEventsService],
})
export class IntegrationEventsModule {}
