import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { IntegrationsModule } from 'modules/integrations/integrations.module';

import ActionEventService from './action-event.service';
import { ACTIONS_QUEUE } from './actions.interface';
import { ActionsProcessor } from './actions.processor';
import { ActionsQueue } from './actions.queue';

@Module({
  imports: [
    PrismaModule,
    HttpModule,
    IntegrationsModule,
    BullModule.registerQueue({ name: ACTIONS_QUEUE }),
  ],
  controllers: [],
  // TODO: Add respective models used in the service. For now using prismaService
  providers: [
    ActionEventService,
    ActionsQueue,
    ActionsProcessor,
    PrismaService,
  ],
  // `ActionsQueue` is exported because the other places that start an action —
  // the webhook receiver, and the manual trigger on ActionService — live in
  // other modules. Running one stays here.
  exports: [ActionEventService, ActionsQueue],
})
export class ActionEventModule {}
