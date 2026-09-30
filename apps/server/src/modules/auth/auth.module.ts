import { Global, Module } from '@nestjs/common';

import { UsersModule } from 'modules/users/users.module';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

/**
 * Global, because many modules provide UsersService and WorkspacesService
 * directly, and both of them need AuthService.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
  imports: [UsersModule],
})
export class AuthModule {}
