import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { IssuesModule } from 'modules/issues/issues.module';
import { NotificationsModule } from 'modules/notifications/notifications.module';
import { UsersService } from 'modules/users/users.service';

import { IssueCommentsController } from './issue-comments.controller';
import IssueCommentsService from './issue-comments.service';

@Module({
  imports: [HttpModule, NotificationsModule, IssuesModule],
  controllers: [IssueCommentsController],
  providers: [IssueCommentsService, UsersService],
  exports: [IssueCommentsService],
})
export class IssueCommentsModule {}
