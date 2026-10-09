import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AnswerAgentQuestionDto } from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { AgentQuestionsService } from './agent-questions.service';

/**
 * Where a person answers a question that an agent asked.
 *
 * Reads need no route, because the questions reach the webapp through the sync
 * log. `WorkspaceResourceGuard` proves the question is in the workspace and
 * that its issue is in a team the caller can see. Anyone who passes may
 * answer, not only the person who started the run.
 */
@Controller({ version: '1', path: 'agent_questions' })
export class AgentQuestionsController {
  constructor(private readonly questions: AgentQuestionsService) {}

  @Post(':agentQuestionId/answer')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async answer(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Param('agentQuestionId') agentQuestionId: string,
    @Body() body: AnswerAgentQuestionDto,
  ) {
    try {
      return await this.questions.answer(
        agentQuestionId,
        { workspaceId, userId },
        body,
      );
    } catch (error) {
      if (error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
