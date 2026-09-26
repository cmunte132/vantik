/**
 * What happens to a run nobody is watching.
 *
 * The sweep is the one path where a run reaches a terminal state with no
 * request in flight and no person on the other end, so everything a finished
 * run normally gets has to be written here or not at all. It was not: expiry
 * transitioned the row and stopped, so the issue said nothing, and the next
 * attempt was a QUEUED row that no backend was ever handed.
 */
import type { ExpiredRun } from './agent-runs.service';

import { AgentRunsProcessor } from './agent-runs.processor';

function build(expired: ExpiredRun[], options: { retryThrows?: boolean } = {}) {
  const agentRuns = {
    expireLapsedLeases: jest.fn(async () => expired),
  };

  const retried: string[] = [];
  const delegation = {
    retry: jest.fn(async (runId: string) => {
      if (options.retryThrows) {
        throw new Error('this run has already been retried by hand');
      }

      retried.push(runId);
      return { id: `${runId}-next`, attempt: 2 };
    }),
  };

  const handbacks: Array<{
    issueId: string;
    agentUserId: string;
    runId: string;
    outcome: Record<string, unknown>;
  }> = [];
  const handback = {
    post: jest.fn(
      async (
        issueId: string,
        agentUserId: string,
        runId: string,
        outcome: Record<string, unknown>,
      ) => {
        handbacks.push({ issueId, agentUserId, runId, outcome });
      },
    ),
  };

  const processor = new AgentRunsProcessor(
    agentRuns as never,
    delegation as never,
    handback as never,
  );

  return { processor, delegation, handback, handbacks, retried };
}

function lapsed(over: Partial<ExpiredRun> = {}): ExpiredRun {
  return {
    id: 'run-1',
    issueId: 'issue-1',
    agentUserId: 'agent-1',
    workspaceId: 'workspace-1',
    attempt: 1,
    retryable: true,
    ...over,
  };
}

describe('the sweep says what happened', () => {
  it('tells the issue the run stopped responding', async () => {
    const { processor, handbacks } = build([lapsed()]);

    await processor.sweep();

    // Not merely a status in a list only somebody already suspicious would
    // open. `LEASE_LOST` has had prose in the handback since the lease
    // existed, and nothing could ever render it.
    expect(handbacks[0]).toMatchObject({
      issueId: 'issue-1',
      agentUserId: 'agent-1',
      runId: 'run-1',
      outcome: { status: 'EXPIRED', failure: 'LEASE_LOST', attempt: 1 },
    });
  });

  it('names the attempt that is already running in its place', async () => {
    const { processor, handbacks, retried } = build([lapsed()]);

    await processor.sweep();

    expect(retried).toEqual(['run-1']);
    // Otherwise a second run appears on the issue with nothing explaining
    // where it came from.
    expect(handbacks[0].outcome.nextAttempt).toBe(2);
  });

  it('says nothing about a next attempt when there will not be one', async () => {
    const { processor, handbacks, delegation } = build([
      lapsed({ attempt: 3, retryable: false }),
    ]);

    await processor.sweep();

    expect(delegation.retry).not.toHaveBeenCalled();
    expect(handbacks[0].outcome.nextAttempt).toBeNull();
  });

  it('still speaks for a run whose retry could not be opened', async () => {
    // The comment is the only word the issue gets. A retry refused — already
    // retried by hand, an executor since unregistered — must not swallow it.
    const { processor, handbacks } = build([lapsed()], { retryThrows: true });

    await processor.sweep();

    expect(handbacks).toHaveLength(1);
    expect(handbacks[0].outcome.nextAttempt).toBeNull();
  });

  it('keeps going when one run cannot be spoken for', async () => {
    const { processor, handback, handbacks } = build([
      lapsed({ id: 'run-1', issueId: 'issue-1' }),
      lapsed({ id: 'run-2', issueId: 'issue-2' }),
    ]);

    handback.post.mockImplementationOnce(async () => {
      throw new Error('the comment table is unreachable');
    });

    await expect(processor.sweep()).resolves.toEqual({
      expired: 2,
      requeued: 2,
    });
    expect(handbacks.map((entry) => entry.runId)).toEqual(['run-2']);
  });

  it('does nothing at all when nothing lapsed', async () => {
    const { processor, delegation, handback } = build([]);

    await expect(processor.sweep()).resolves.toEqual({
      expired: 0,
      requeued: 0,
    });
    expect(delegation.retry).not.toHaveBeenCalled();
    expect(handback.post).not.toHaveBeenCalled();
  });
});
