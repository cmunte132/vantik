import { Module } from '@nestjs/common';

import { SupertokensService } from 'modules/auth/supertokens/supertokens.service';
import WorkspacesService from 'modules/workspaces/workspaces.service';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [SupertokensService, WorkspacesService, UsersService],
  exports: [UsersService],
})
export class UsersModule {}
