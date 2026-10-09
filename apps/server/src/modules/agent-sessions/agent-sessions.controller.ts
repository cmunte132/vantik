import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { LinkAgentSessionDto } from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { AgentSessionsService } from './agent-sessions.service';

/**
 * Where an agent says which issue its session works on.
 *
 * The session acts as the caller, so a caller can only link its own
 * sessions. The sessions reach the webapp through the sync log, so the only
 * read is the terminal steps of a session without a run.
 *
 * `WorkspaceResourceGuard` proves the issue is in the workspace and in a team
 * the caller can see, before the handler runs.
 */
@Controller({ version: '1', path: 'agent_sessions' })
export class AgentSessionsController {
  constructor(private readonly sessions: AgentSessionsService) {}

  /**
   * What a person did in their own terminal, in a session that has no run.
   * A session with a run keeps these steps in the run's events.
   */
  @Get(':sessionId/events')
  @UseGuards(AuthGuard)
  async events(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.sessions.listEvents({ userId, workspaceId }, sessionId);
  }

  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async link(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Body() body: LinkAgentSessionDto,
  ) {
    try {
      return await this.sessions.linkHookSession({ userId, workspaceId }, body);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
