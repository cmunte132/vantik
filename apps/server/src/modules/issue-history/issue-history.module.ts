import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import IssueHistoryService from './issue-history.service';

@Module({
  imports: [HttpModule],
  controllers: [],
  providers: [IssueHistoryService],
  exports: [IssueHistoryService],
})
export class IssueHistoryModule {}
