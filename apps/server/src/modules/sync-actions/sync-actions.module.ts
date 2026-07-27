import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { SyncActionsController } from './sync-actions.controller';
import SyncActionsService from './sync-actions.service';
import { SyncRepairService } from './sync-repair.service';

@Module({
  imports: [PrismaModule, HttpModule],
  controllers: [SyncActionsController],
  // TODO: Add respective models used in the service. For now using prismaService
  providers: [SyncActionsService, SyncRepairService, PrismaService, UsersService],
  exports: [SyncActionsService, SyncRepairService],
})
export class SyncActionsModule {}
