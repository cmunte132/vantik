import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { ActionEventModule } from 'modules/action-event/action-event.module';
import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { TriggerdevService } from 'modules/triggerdev/triggerdev.service';
import { UsersService } from 'modules/users/users.service';
import WorkspacesService from 'modules/workspaces/workspaces.service';

import { ActionController } from './action.controller';
import ActionService from './action.service';

@Module({
  // ActionEventModule for the actions queue: running an action is dispatched,
  // not called, so the schedule trigger and the inputs request go through it.
  imports: [PrismaModule, IntegrationsModule, ActionEventModule],
  controllers: [ActionController],
  providers: [
    PrismaService,
    ActionService,
    UsersService,
    TriggerdevService,
    WorkspacesService,
  ],
  exports: [ActionService],
})
export class ActionModule {}
