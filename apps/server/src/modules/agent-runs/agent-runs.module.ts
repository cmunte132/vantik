import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { ChecklistItemsModule } from 'modules/checklist-items/checklist-items.module';
import { ConnectorModule } from 'modules/connector/connector.module';
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
import { LocalExecutor } from './executors/local.executor';
import { KnowledgeArmsService } from './knowledge-arms.service';
import { RunCleanupService } from './run-cleanup.service';
import { RunHandbackService } from './run-handback.service';
import { RunOutboxService } from './run-outbox';
import { RunTokensService } from './run-tokens.service';
import { GitProxyService } from './sandbox/git-proxy.service';
import { RemoteSandboxRuntime } from './sandbox/remote.runtime';

@Module({
  imports: [
    BullModule.registerQueue({ name: AGENT_RUNS_QUEUE }),
    IssuesModule,
    IssueCommentsModule,
    LinkedIssueModule,
    // What an agent writes to Vantik from its sandbox, applied as the agent.
    ChecklistItemsModule,
    // What the workspace knows, for the run's pack, and what came of it.
    PagesModule,
    KnowledgeSignalsModule,
    CredentialsModule,
    // Where a run's code comes from and where its branch goes.
    GitModule,
    // The sockets local connectors dial, and who is online.
    ConnectorModule,
  ],
  controllers: [AgentRunsController, CredentialsController],
  providers: [
    AgentRunsService,
    AgentDelegationService,
    ContextPackService,
    KnowledgeArmsService,
    RunHandbackService,
    RunCleanupService,
    RunOutboxService,
    ExecutorRegistry,
    HostedExecutor,
    LocalExecutor,
    RunTokensService,
    RemoteSandboxRuntime,
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
