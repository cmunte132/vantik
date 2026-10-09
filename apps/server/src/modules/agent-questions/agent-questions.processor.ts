import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import {
  AGENT_QUESTION_EXPIRY_CRON,
  AGENT_QUESTION_EXPIRY_JOB,
  AGENT_QUESTION_EXPIRY_JOB_ID,
  AGENT_QUESTIONS_QUEUE,
} from './agent-questions.interface';
import { AgentQuestionsService } from './agent-questions.service';

/**
 * Schedules the sweep that expires unanswered questions, as a Bull repeatable
 * job like the agent run lease sweep. An agent never waits for ever: the tool
 * has its own timer, and this sweep makes the record agree with it.
 */
@Injectable()
export class AgentQuestionsScheduler implements OnModuleInit {
  private readonly logger = new LoggerService('AgentQuestionsScheduler');

  constructor(@InjectQueue(AGENT_QUESTIONS_QUEUE) private queue: Queue) {}

  async onModuleInit() {
    // A schedule that fails should degrade the feature, not stop the server.
    try {
      // Bull keys a repeatable job by its cron expression, so a changed
      // schedule is cleared first or the sweep runs on both.
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter((job) => job.name === AGENT_QUESTION_EXPIRY_JOB)
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );

      await this.queue.add(
        AGENT_QUESTION_EXPIRY_JOB,
        {},
        {
          jobId: AGENT_QUESTION_EXPIRY_JOB_ID,
          repeat: { cron: AGENT_QUESTION_EXPIRY_CRON.trim() },
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    } catch (error) {
      this.logger.error({
        message: `Could not schedule the agent question expiry: ${error}`,
        where: 'AgentQuestionsScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

@Processor(AGENT_QUESTIONS_QUEUE)
export class AgentQuestionsProcessor {
  constructor(private questions: AgentQuestionsService) {}

  @Process(AGENT_QUESTION_EXPIRY_JOB)
  async expire() {
    return { expired: await this.questions.expireDue() };
  }
}
