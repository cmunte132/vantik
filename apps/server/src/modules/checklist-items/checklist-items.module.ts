import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { ChecklistItemsController } from './checklist-items.controller';
import ChecklistItemsService from './checklist-items.service';

@Module({
  controllers: [ChecklistItemsController],
  providers: [ChecklistItemsService, UsersService],
  exports: [ChecklistItemsService],
})
export class ChecklistItemsModule {}
