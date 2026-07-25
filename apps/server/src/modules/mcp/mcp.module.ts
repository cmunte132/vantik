import { Module } from '@nestjs/common';
import { PrismaModule } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { McpController } from './mcp.controller';

/**
 * The endpoint's rate limit is configured in McpThrottleGuard rather than here:
 * ThrottlerModule is global, so a second `forRoot` in this module would be
 * shadowed by the app-wide one instead of scoping anything.
 *
 * UsersService is provided because AuthGuard resolves it out of the module it
 * guards, the same way every other controller in the app supplies it.
 */
@Module({
  imports: [PrismaModule],
  controllers: [McpController],
  providers: [UsersService],
})
export class McpModule {}
