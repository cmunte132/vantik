import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PrismaModule } from 'nestjs-prisma';

import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { UsersService } from 'modules/users/users.service';

import { ModuleRoutingProcessor } from './module-routing.processor';
import {
  ModuleRoutingQueue,
  MODULE_ROUTING_QUEUE,
} from './module-routing.queue';
import { ModuleRoutingService } from './module-routing.service';
import { ModulesController } from './modules.controller';
import { ModulesService } from './modules.service';

@Module({
  imports: [
    PrismaModule,
    IntegrationsModule,
    BullModule.registerQueue({ name: MODULE_ROUTING_QUEUE }),
  ],
  controllers: [ModulesController],
  providers: [
    ModulesService,
    ModuleRoutingService,
    ModuleRoutingQueue,
    ModuleRoutingProcessor,
    UsersService,
  ],
  exports: [ModulesService, ModuleRoutingService, ModuleRoutingQueue],
})
export class ModulesModule {}
