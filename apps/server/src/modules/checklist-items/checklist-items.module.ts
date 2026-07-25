import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { ChecklistItemsController } from './checklist-items.controller';
import ChecklistItemsService from './checklist-items.service';

@Module({
  imports: [PrismaModule],
  controllers: [ChecklistItemsController],
  providers: [ChecklistItemsService, PrismaService, UsersService],
  exports: [ChecklistItemsService],
})
export class ChecklistItemsModule {}
