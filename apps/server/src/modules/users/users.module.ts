import { Module } from '@nestjs/common';

import WorkspacesService from 'modules/workspaces/workspaces.service';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [WorkspacesService, UsersService],
  exports: [UsersService],
})
export class UsersModule {}
