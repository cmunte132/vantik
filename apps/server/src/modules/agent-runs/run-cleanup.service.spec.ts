import { ConflictException } from '@nestjs/common';

import { RunCleanupService } from './run-cleanup.service';

const SOURCE = {
  integrationAccountId: 'account-1',
  externalRepoId: 'repo-1',
  fullName: 'o/app',
};

function build(run: Record<string, unknown>) {
  const agentRuns = {
    getRun: jest.fn(async () => ({
      id: 'run-1',
      workspaceId: 'ws',
      config: { source: SOURCE },
      ...run,
    })),
    recordCleanup: jest.fn(async (): Promise<void> => undefined),
  };
  const gitProxy = {
    cleanUp: jest.fn(async () => ({
      pullRequest: 'closed' as const,
      branch: 'deleted' as const,
    })),
  };
  const service = new RunCleanupService(agentRuns as never, gitProxy as never);

  return { service, agentRuns, gitProxy };
}

const SCOPE = { workspaceId: 'ws', onlyAgentUserId: null as string | null };

describe('RunCleanupService', () => {
  it('closes the pull request and deletes the branch of a run awaiting review', async () => {
    const { service, agentRuns, gitProxy } = build({
      status: 'NEEDS_REVIEW',
      result: {
        branch: 'agent/eng-1',
        headCommit: 'abc',
        prUrl: 'https://forgejo.test/o/app/pulls/1',
      },
    });

    const cleanup = await service.cleanUp('run-1', SCOPE, 'user-1');

    expect(gitProxy.cleanUp).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws',
        source: SOURCE,
        branch: 'agent/eng-1',
        headCommit: 'abc',
        prUrl: 'https://forgejo.test/o/app/pulls/1',
      }),
    );
    expect(cleanup).toMatchObject({
      byUserId: 'user-1',
      pullRequest: 'closed',
      branch: 'deleted',
    });
    expect(agentRuns.recordCleanup).toHaveBeenCalledWith(
      'run-1',
      cleanup,
      'Cleaned up after the run. Closed the pull request. Deleted the branch.',
    );
  });

  it('answers a second request with the cleanup already done', async () => {
    const done = {
      at: '2026-10-03T00:00:00.000Z',
      byUserId: 'user-1',
      pullRequest: 'closed',
      branch: 'deleted',
    };
    const { service, gitProxy } = build({
      status: 'NEEDS_REVIEW',
      result: { branch: 'agent/eng-1', prUrl: 'x', cleanedUp: done },
    });

    await expect(service.cleanUp('run-1', SCOPE, 'user-2')).resolves.toBe(done);
    expect(gitProxy.cleanUp).not.toHaveBeenCalled();
  });

  it('retries only the half that failed last time', async () => {
    const { service, gitProxy } = build({
      status: 'FAILED',
      result: {
        branch: 'agent/eng-1',
        headCommit: 'abc',
        prUrl: 'https://forgejo.test/o/app/pulls/1',
        cleanedUp: {
          at: '2026-10-03T00:00:00.000Z',
          byUserId: 'user-1',
          pullRequest: 'closed',
          branch: 'failed',
        },
      },
    });
    gitProxy.cleanUp.mockResolvedValueOnce({
      pullRequest: 'none' as never,
      branch: 'deleted',
    });

    const cleanup = await service.cleanUp('run-1', SCOPE, 'user-1');

    expect(gitProxy.cleanUp.mock.calls[0]).toEqual([
      expect.not.objectContaining({ prUrl: expect.anything() }),
    ]);
    expect(cleanup).toMatchObject({ pullRequest: 'closed', branch: 'deleted' });
  });

  it('refuses a run that succeeded, whose pull request is the work', async () => {
    const { service, gitProxy } = build({
      status: 'SUCCEEDED',
      result: { branch: 'agent/eng-1', prUrl: 'x' },
    });

    await expect(
      service.cleanUp('run-1', SCOPE, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gitProxy.cleanUp).not.toHaveBeenCalled();
  });
});
