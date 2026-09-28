import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { GitModule } from 'modules/git/git.module';
import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { PAGES_QUEUE } from 'modules/pages/pages.interface';
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
    IntegrationsModule,
    // A linked repository must be one a connected source offers, and its
    // folders come from the server's mirror of it.
    GitModule,
    BullModule.registerQueue({ name: MODULE_ROUTING_QUEUE }),
    // Edits to a module's repositories move the modules knowledge entries
    // resolve to; the pages processor re-resolves them.
    BullModule.registerQueue({ name: PAGES_QUEUE }),
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
