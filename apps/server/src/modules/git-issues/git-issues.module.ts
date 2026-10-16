import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PluginsModule } from 'plugins/plugins.module';

import { GIT_ISSUES_QUEUE } from './git-issues.interface';
import { GitIssuesProcessor, GitIssuesScheduler } from './git-issues.processor';
import { GitIssuesService } from './git-issues.service';

@Module({
  // PluginsModule because writes go through a plugin context as the
  // local-repo bot, the same path the other integrations write by.
  imports: [
    PluginsModule,
    BullModule.registerQueue({ name: GIT_ISSUES_QUEUE }),
  ],
  providers: [GitIssuesService, GitIssuesScheduler, GitIssuesProcessor],
  exports: [GitIssuesService],
})
export class GitIssuesModule {}
