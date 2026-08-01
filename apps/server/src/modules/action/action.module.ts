import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { ActionEventModule } from 'modules/action-event/action-event.module';
import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { UsersService } from 'modules/users/users.service';
import WorkspacesService from 'modules/workspaces/workspaces.service';

import {
  ACTION_SCHEDULES_QUEUE,
  ActionScheduleProcessor,
  ActionScheduleScheduler,
} from './action-schedule.processor';
import { ActionController } from './action.controller';
import ActionService from './action.service';

@Module({
  // ActionEventModule for the actions queue: running an action is dispatched,
  // not called, so the schedule trigger and the inputs request go through it.
  imports: [
    PrismaModule,
    IntegrationsModule,
    ActionEventModule,
    BullModule.registerQueue({ name: ACTION_SCHEDULES_QUEUE }),
  ],
  controllers: [ActionController],
  providers: [
    PrismaService,
    ActionService,
    UsersService,
    ActionScheduleScheduler,
    ActionScheduleProcessor,
    WorkspacesService,
  ],
  exports: [ActionService],
})
export class ActionModule {}
