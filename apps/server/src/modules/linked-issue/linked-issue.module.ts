import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { LinkedIssueController } from './linked-issue.controller';
import LinkedIssueService from './linked-issue.service';

@Module({
  imports: [HttpModule],
  controllers: [LinkedIssueController],
  providers: [LinkedIssueService, UsersService],
  exports: [LinkedIssueService],
})
export class LinkedIssueModule {}
