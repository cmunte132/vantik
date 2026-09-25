import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { AIRequestsController } from './ai-requests.controller';
import AIRequestsService from './ai-requests.services';

@Module({
  controllers: [AIRequestsController],
  providers: [AIRequestsService, UsersService],
  exports: [AIRequestsService],
})
export class AIRequestsModule {}
