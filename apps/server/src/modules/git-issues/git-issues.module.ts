import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PluginsModule } from 'plugins/plugins.module';

import { AgentSessionsModule } from 'modules/agent-sessions/agent-sessions.module';
import { GitModule } from 'modules/git/git.module';

import { GIT_ISSUES_QUEUE } from './git-issues.interface';
import { GitIssuesProcessor, GitIssuesScheduler } from './git-issues.processor';
import { GitIssuesService } from './git-issues.service';
import { GitRemoteRepositoryTargets } from './git-remote-repository-targets';
import { LocalRepositoryTargets } from './local-repository-targets';
import { GIT_ISSUES_TARGETS } from './mirror-targets';

@Module({
  // PluginsModule because writes go through a plugin context as the bot of the
  // source, the same path the other integrations write by. GitModule because
  // the pass works in the server's mirror of each repository.
  imports: [
    PluginsModule,
    GitModule,
    // The session that a hand-off names is recorded on the issue.
    AgentSessionsModule,
    BullModule.registerQueue({ name: GIT_ISSUES_QUEUE }),
  ],
  providers: [
    GitIssuesService,
    GitIssuesScheduler,
    GitIssuesProcessor,
    LocalRepositoryTargets,
    GitRemoteRepositoryTargets,
    // One list for each tier of source that can carry the mirror. A tier
    // joins when you add its `MirrorTargets` here.
    {
      provide: GIT_ISSUES_TARGETS,
      useFactory: (
        local: LocalRepositoryTargets,
        remote: GitRemoteRepositoryTargets,
      ) => [local, remote],
      inject: [LocalRepositoryTargets, GitRemoteRepositoryTargets],
    },
  ],
  exports: [GitIssuesService],
})
export class GitIssuesModule {}
