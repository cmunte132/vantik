import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { AttachmentController } from './attachments.controller';
import { AttachmentService } from './attachments.service';
import { StorageFactory } from './storage.factory';

@Module({
  controllers: [AttachmentController],
  providers: [AttachmentService, UsersService, StorageFactory],
  exports: [AttachmentService],
})
export class AttachmentModule {}
