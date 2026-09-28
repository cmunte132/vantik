import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { GitModule } from 'modules/git/git.module';
import { IssueCommentsModule } from 'modules/issue-comments/issue-comments.module';
import { IssuesModule } from 'modules/issues/issues.module';
import { KnowledgeSignalsModule } from 'modules/knowledge-signals/knowledge-signals.module';
import { LinkedIssueModule } from 'modules/linked-issue/linked-issue.module';
import { PagesModule } from 'modules/pages/pages.module';
import { UsersService } from 'modules/users/users.service';

import { AgentDelegationService } from './agent-delegation.service';
import { AgentRunsController } from './agent-runs.controller';
import { AGENT_RUNS_QUEUE } from './agent-runs.interface';
import { AgentRunsProcessor, AgentRunsScheduler } from './agent-runs.processor';
import { AgentRunsService } from './agent-runs.service';
import { ContextPackService } from './context-pack.service';
import { CredentialsController } from './credentials/credentials.controller';
import { CredentialsModule } from './credentials/credentials.module';
import { ExecutorRegistry } from './executors/executor.registry';
import { HostedExecutor } from './executors/hosted.executor';
import { KnowledgeArmsService } from './knowledge-arms.service';
import { RunHandbackService } from './run-handback.service';
import { GitProxyService } from './sandbox/git-proxy.service';
import { GondolinRuntime } from './sandbox/gondolin.runtime';

@Module({
  imports: [
    BullModule.registerQueue({ name: AGENT_RUNS_QUEUE }),
    IssuesModule,
    IssueCommentsModule,
    LinkedIssueModule,
    // What the workspace knows, for the run's pack, and what came of it.
    PagesModule,
    KnowledgeSignalsModule,
    CredentialsModule,
    // Where a run's code comes from and where its branch goes.
    GitModule,
  ],
  controllers: [AgentRunsController, CredentialsController],
  providers: [
    AgentRunsService,
    AgentDelegationService,
    ContextPackService,
    KnowledgeArmsService,
    RunHandbackService,
    ExecutorRegistry,
    HostedExecutor,
    GondolinRuntime,
    GitProxyService,
    AgentRunsScheduler,
    AgentRunsProcessor,
    // AuthGuard resolves UsersService out of the module it guards, so every
    // module with a guarded controller has to provide it.
    UsersService,
  ],
  exports: [
    AgentRunsService,
    AgentDelegationService,
    ExecutorRegistry,
    CredentialsModule,
  ],
})
export class AgentRunsModule {}
