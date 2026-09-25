import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { UsersService } from 'modules/users/users.service';

import { AttachmentController } from './attachments.controller';
import { AttachmentService } from './attachments.service';
import { StorageFactory } from './storage.factory';

@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
    }),
  ],
  controllers: [AttachmentController],
  providers: [AttachmentService, UsersService, StorageFactory],
  exports: [AttachmentService],
})
export class AttachmentModule {}
