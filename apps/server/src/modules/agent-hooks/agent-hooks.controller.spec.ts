import { BadRequestException } from '@nestjs/common';

import { REQUIRED_AGENT_SCOPE } from 'modules/auth/agent-scope';

import { AgentHooksController } from './agent-hooks.controller';
import { AgentHooksService } from './agent-hooks.service';

function controllerSaying(text: string | null) {
  const run = jest.fn(async () => text);
  const controller = new AgentHooksController({
    run,
  } as unknown as AgentHooksService);

  return { controller, run };
}

describe('AgentHooksController', () => {
  it('passes the hook to the rules as the calling account, and answers in its harness', async () => {
    const { controller, run } = controllerSaying('ENG-42 went quiet.');

    const output = await controller.handle(
      'stop',
      'cursor',
      { conversation_id: 'conv-1', loop_count: 0 },
      'agent-1',
      'ws-1',
    );

    expect(run).toHaveBeenCalledWith(
      'stop',
      { userId: 'agent-1', workspaceId: 'ws-1' },
      {
        sessionId: 'conv-1',
        source: null,
        prompt: null,
        toolName: null,
        continued: false,
      },
      { canSay: true },
    );
    expect(output).toEqual({ followup_message: 'ENG-42 went quiet.' });
  });

  it('refuses a hook it does not know', async () => {
    const { controller, run } = controllerSaying(null);

    await expect(
      controller.handle('pre-tool-use', 'codex', {}, 'agent-1', 'ws-1'),
    ).rejects.toThrow(BadRequestException);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a call that does not say which harness it is', async () => {
    // Guessing would answer in a format the harness may silently ignore.
    const { controller } = controllerSaying(null);

    for (const harness of [undefined, 'gemini']) {
      await expect(
        controller.handle(
          'stop',
          harness as unknown as string,
          {},
          'agent-1',
          'ws-1',
        ),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('asks only for the read scope, though it is a POST', () => {
    // The hooks report on the agent's own work and write nothing to the
    // tracker; a read-only agent is exactly the one that most needs them.
    expect(
      Reflect.getMetadata(
        REQUIRED_AGENT_SCOPE,
        AgentHooksController.prototype.handle,
      ),
    ).toBe('read');
  });
});
