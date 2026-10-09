import { Module } from '@nestjs/common';

import { AgentSessionsModule } from 'modules/agent-sessions/agent-sessions.module';
import { CachceModule } from 'modules/cache/cache.module';
import { UsersService } from 'modules/users/users.service';
import { VectorModule } from 'modules/vector/vector.module';

import { AgentHooksController } from './agent-hooks.controller';
import { AgentHooksService } from './agent-hooks.service';

/**
 * UsersService is provided because AuthGuard resolves it out of the module it
 * guards, the same way every other controller in the app supplies it.
 */
@Module({
  imports: [AgentSessionsModule, CachceModule, VectorModule],
  controllers: [AgentHooksController],
  providers: [AgentHooksService, UsersService],
})
export class AgentHooksModule {}
