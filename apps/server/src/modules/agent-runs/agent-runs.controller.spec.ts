import { ForbiddenException } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';

import { AgentRunsController } from './agent-runs.controller';

/**
 * Only a person starts agent work. An agent token — a Claude Code session, a
 * script, a run's own identity — is refused at the door, so no agent can put
 * work on the workspace's model key, whatever tool it reaches the API through.
 */
describe('AgentRunsController delegation', () => {
  const WORKSPACE = 'workspace-1';

  function build() {
    const delegation = {
      delegate: jest.fn(async () => ({ id: 'run-1' })),
      retry: jest.fn(async () => ({ id: 'run-2' })),
    };
    const users = {
      provisionRunIdentity: jest.fn(async () => ({ id: 'run-identity' })),
    };

    const controller = new AgentRunsController(
      {} as never,
      delegation as never,
      {} as never,
      {} as never,
      {} as never,
      users as never,
      {} as never,
      {} as never,
    );

    return { controller, delegation };
  }

  it('lets a person delegate an issue', async () => {
    const { controller, delegation } = build();

    await controller.createRun(WORKSPACE, 'user-1', RoleEnum.USER, {
      issueId: 'issue-1',
    } as never);

    expect(delegation.delegate).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'issue-1', createdById: 'user-1' }),
    );
  });

  it('refuses an agent that tries to delegate', async () => {
    const { controller, delegation } = build();

    await expect(
      controller.createRun(WORKSPACE, 'agent-1', RoleEnum.AGENT, {
        issueId: 'issue-1',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(delegation.delegate).not.toHaveBeenCalled();
  });

  it('refuses an agent that tries to retry a run', async () => {
    const { controller, delegation } = build();

    await expect(
      controller.retryRun(WORKSPACE, 'agent-1', RoleEnum.AGENT, {
        agentRunId: 'run-1',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(delegation.retry).not.toHaveBeenCalled();
  });
});
