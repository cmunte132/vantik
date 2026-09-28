import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { RequiresScope } from 'modules/auth/agent-scope';
import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import {
  canSay,
  HARNESSES,
  HOOK_EVENTS,
  hookOutput,
  readHookInput,
} from './agent-hooks.harness';
import { AgentHooksService } from './agent-hooks.service';

/**
 * The one place a coding agent's hooks reach Vantik, whichever tool it runs in.
 *
 * The body is the hook's own input, exactly as the harness wrote it, and the
 * response is the JSON that harness reads back — so Cursor's hook is a `curl`
 * that pipes one into the other. Claude Code and Codex come in through the MCP
 * server's hook tools instead, which call this over loopback with the token
 * their MCP connection already carries.
 *
 * A read, as far as scopes go: the hooks report on the agent's own issues and
 * write nothing to the tracker. The only thing stored is when the session
 * began and when it was last held up, which the rules need and nothing else
 * reads.
 */
@Controller({ version: '1', path: 'agent-hooks' })
export class AgentHooksController {
  constructor(private readonly hooks: AgentHooksService) {}

  @UseGuards(AuthGuard)
  @RequiresScope('read')
  @Post(':event')
  @HttpCode(200)
  async handle(
    @Param('event') event: string,
    @Query('harness') harness: string,
    @Body() body: unknown,
    @UserId() userId: string,
    @Workspace() workspaceId: string,
  ): Promise<Record<string, unknown>> {
    if (!isOneOf(HOOK_EVENTS, event)) {
      throw new BadRequestException(
        `No such hook. Available: ${HOOK_EVENTS.join(', ')}.`,
      );
    }

    if (!isOneOf(HARNESSES, harness)) {
      throw new BadRequestException(
        `Say which harness is calling with ?harness=: ${HARNESSES.join(', ')}.`,
      );
    }

    const text = await this.hooks.run(
      event,
      { userId, workspaceId },
      readHookInput(body),
      { canSay: canSay(harness, event) },
    );

    return hookOutput(harness, event, text);
  }
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
