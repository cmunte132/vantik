import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { WorkflowsController } from './workflows.controller';
import WorkflowsService from './workflows.service';

@Module({
  imports: [HttpModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, UsersService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
