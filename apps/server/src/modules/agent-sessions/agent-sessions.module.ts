import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { AgentSessionsController } from './agent-sessions.controller';
import { AgentSessionsService } from './agent-sessions.service';

/**
 * UsersService is provided because AuthGuard resolves it out of the module it
 * guards, the same way every other controller in the app supplies it.
 */
@Module({
  controllers: [AgentSessionsController],
  providers: [AgentSessionsService, UsersService],
  exports: [AgentSessionsService],
})
export class AgentSessionsModule {}
