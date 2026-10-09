import {
  BadRequestException,
  Body,
  Controller,
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
 * sessions. Reads need no route, because the sessions reach the webapp through
 * the sync log.
 *
 * `WorkspaceResourceGuard` proves the issue is in the workspace and in a team
 * the caller can see, before the handler runs.
 */
@Controller({ version: '1', path: 'agent_sessions' })
export class AgentSessionsController {
  constructor(private readonly sessions: AgentSessionsService) {}

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
