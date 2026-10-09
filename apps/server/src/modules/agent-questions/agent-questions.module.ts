import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { AgentQuestionsController } from './agent-questions.controller';
import { AGENT_QUESTIONS_QUEUE } from './agent-questions.interface';
import {
  AgentQuestionsProcessor,
  AgentQuestionsScheduler,
} from './agent-questions.processor';
import { AgentQuestionsService } from './agent-questions.service';

/**
 * UsersService is provided because AuthGuard resolves it out of the module it
 * guards, the same way every other controller in the app supplies it.
 */
@Module({
  imports: [BullModule.registerQueue({ name: AGENT_QUESTIONS_QUEUE })],
  controllers: [AgentQuestionsController],
  providers: [
    AgentQuestionsService,
    AgentQuestionsScheduler,
    AgentQuestionsProcessor,
    UsersService,
  ],
  exports: [AgentQuestionsService],
})
export class AgentQuestionsModule {}
