import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import AIRequestsService from './ai-requests.services';

@Module({
  providers: [AIRequestsService, UsersService],
  exports: [AIRequestsService],
})
export class AIRequestsModule {}
