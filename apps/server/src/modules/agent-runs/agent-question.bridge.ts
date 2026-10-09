import type { AgentQuestion } from '@prisma/client';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import {
  AgentQuestionHooks,
  AgentQuestionsService,
} from 'modules/agent-questions/agent-questions.service';

import { AgentRunsService } from './agent-runs.service';
import { ExecutorRegistry } from './executors/executor.registry';

/**
 * The part of the question service that needs the executors.
 *
 * The question service cannot import the agent-runs module, because the
 * executors import the question service. This class closes the loop at boot,
 * in the way the local executor registers itself with the connector registry.
 * It hands the end of a question to the executor of the run that asked, and
 * writes the question's events on that run's feed.
 */
@Injectable()
export class AgentQuestionBridge implements AgentQuestionHooks, OnModuleInit {
  constructor(
    private questions: AgentQuestionsService,
    private registry: ExecutorRegistry,
    private agentRuns: AgentRunsService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.questions.setHooks(this);
  }

  async deliver(question: AgentQuestion): Promise<boolean> {
    if (!question.agentRunId) {
      return false;
    }

    const run = await this.prisma.agentRun.findFirst({
      where: { id: question.agentRunId, deleted: null },
    });

    // A run that is over has no agent to tell.
    if (!run || !this.registry.has(run.executor)) {
      return false;
    }

    const executor = this.registry.get(run.executor);

    return executor.deliverAnswer ? executor.deliverAnswer(run, question) : false;
  }

  async event(question: AgentQuestion, message: string): Promise<void> {
    if (!question.agentRunId) {
      return;
    }

    await this.agentRuns.appendEvent(
      question.agentRunId,
      {
        message,
        phase: 'implement',
        data: {
          kind: 'question',
          agentQuestionId: question.id,
          status: question.status,
        },
      },
      { workspaceId: question.workspaceId },
    );
  }
}
