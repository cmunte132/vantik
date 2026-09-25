import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';

@Module({
  controllers: [ConversationController],
  providers: [ConversationService, UsersService],
  exports: [ConversationService],
})
export class ConversationModule {}
