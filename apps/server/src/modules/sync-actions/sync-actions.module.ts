import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { SyncActionsController } from './sync-actions.controller';
import SyncActionsService from './sync-actions.service';
import { SyncRepairService } from './sync-repair.service';

@Module({
  imports: [HttpModule],
  controllers: [SyncActionsController],
  // TODO: Add respective models used in the service. For now using prismaService
  providers: [SyncActionsService, SyncRepairService, UsersService],
  exports: [SyncActionsService, SyncRepairService],
})
export class SyncActionsModule {}
