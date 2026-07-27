import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { IssueCommentsModule } from 'modules/issue-comments/issue-comments.module';
import { IssuesModule } from 'modules/issues/issues.module';
import { LinkedIssueModule } from 'modules/linked-issue/linked-issue.module';
import { UsersService } from 'modules/users/users.service';

import { AgentDelegationService } from './agent-delegation.service';
import { AgentRunsController } from './agent-runs.controller';
import {
  AGENT_DELEGATION_SERVICE,
  AGENT_RUNS_QUEUE,
} from './agent-runs.interface';
import { AgentRunsProcessor, AgentRunsScheduler } from './agent-runs.processor';
import { AgentRunsService } from './agent-runs.service';
import { ContextPackService } from './context-pack.service';
import { ByoExecutor } from './executors/byo.executor';
import { ExecutorRegistry } from './executors/executor.registry';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: AGENT_RUNS_QUEUE }),
    IssuesModule,
    IssueCommentsModule,
    LinkedIssueModule,
  ],
  controllers: [AgentRunsController],
  providers: [
    AgentRunsService,
    AgentDelegationService,
    // Also published under a string token, so IssuesService can reach it
    // without a value import back into this module.
    { provide: AGENT_DELEGATION_SERVICE, useExisting: AgentDelegationService },
    ContextPackService,
    ExecutorRegistry,
    ByoExecutor,
    AgentRunsScheduler,
    AgentRunsProcessor,
    PrismaService,
    // AuthGuard resolves UsersService out of the module it guards, so every
    // module with a guarded controller has to provide it.
    UsersService,
  ],
  exports: [
    AgentRunsService,
    AgentDelegationService,
    AGENT_DELEGATION_SERVICE,
    ExecutorRegistry,
  ],
})
export class AgentRunsModule {}
