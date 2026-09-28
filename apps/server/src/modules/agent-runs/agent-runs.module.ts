import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { IssueCommentsModule } from 'modules/issue-comments/issue-comments.module';
import { IssuesModule } from 'modules/issues/issues.module';
import { KnowledgeSignalsModule } from 'modules/knowledge-signals/knowledge-signals.module';
import { LinkedIssueModule } from 'modules/linked-issue/linked-issue.module';
import { LocalRepoModule } from 'modules/local-repo/local-repo.module';
import { PagesModule } from 'modules/pages/pages.module';
import { UsersService } from 'modules/users/users.service';

import { AgentDelegationService } from './agent-delegation.service';
import { CredentialsController } from './credentials/credentials.controller';
import { CredentialsService } from './credentials/credentials.service';
import { GitProxyService } from './sandbox/git-proxy.service';
import { GondolinRuntime } from './sandbox/gondolin.runtime';
import { HostedExecutor } from './executors/hosted.executor';
import { AgentRunsController } from './agent-runs.controller';
import { AGENT_RUNS_QUEUE } from './agent-runs.interface';
import { AgentRunsProcessor, AgentRunsScheduler } from './agent-runs.processor';
import { AgentRunsService } from './agent-runs.service';
import { ContextPackService } from './context-pack.service';
import { KnowledgeArmsService } from './knowledge-arms.service';
import { RunHandbackService } from './run-handback.service';
import { ExecutorRegistry } from './executors/executor.registry';

@Module({
  imports: [
    BullModule.registerQueue({ name: AGENT_RUNS_QUEUE }),
    IssuesModule,
    IssueCommentsModule,
    LinkedIssueModule,
    // The issue's modules say which repository a run opens, and a repository on
    // this disk keeps its path here.
    LocalRepoModule,
    // What the workspace knows, for the run's pack, and what came of it.
    PagesModule,
    KnowledgeSignalsModule,
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
    CredentialsService,
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
    CredentialsService,
  ],
})
export class AgentRunsModule {}
