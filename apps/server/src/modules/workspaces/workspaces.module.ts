import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { WorkspacesController } from './workspaces.controller';
import WorkspacesService from './workspaces.service';

@Module({
  imports: [HttpModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, UsersService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
