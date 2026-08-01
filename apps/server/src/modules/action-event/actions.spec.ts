import { ActionsProcessor } from './actions.processor';
import { ActionsQueue } from './actions.queue';
import { type RunActionJob } from './actions.interface';

const job: RunActionJob = {
  slug: 'discord',
  workspaceId: 'ws-1',
  actionId: 'action-1',
  event: 'ON_CREATE',
  payload: { modelId: 'issue-1' },
};

/**
 * Dispatching an action, after moving it off trigger.dev.
 *
 * The behaviour worth pinning is not that a job is added — it is what happens
 * when the queue is unreachable, and what the caller gets back. Both were
 * mistakes in the arrangement this replaces: a `tasks.trigger` to an absent
 * service rejected unobserved, and the id it returned pointed into a system
 * nobody was running.
 */
describe('dispatching an action', () => {
  it('returns the job id, which is what the event records as processed', async () => {
    const add = jest.fn().mockResolvedValue({ id: 42 });
    const queue = new ActionsQueue({ add } as never);

    await expect(queue.run(job)).resolves.toBe('42');

    const [name, data, options] = add.mock.calls[0];
    expect(name).toBe('runAction');
    expect(data).toEqual(job);
    expect(options.attempts).toBeGreaterThan(1);
    expect(options.removeOnFail).toBeGreaterThan(0);
  });

  /**
   * An action that cannot be enqueued must not fail the request that caused it.
   * Creating an issue should not 500 because redis blinked — and the caller
   * needs to be able to tell, which is what the null is for.
   */
  it('does not fail the caller when the queue is unreachable', async () => {
    const add = jest.fn().mockRejectedValue(new Error('redis is down'));
    const queue = new ActionsQueue({ add } as never);

    await expect(queue.run(job)).resolves.toBeNull();
  });

  /** The inputs request is the one caller that waits for an answer. */
  it('waits for a result when the caller needs one', async () => {
    const finished = jest.fn().mockResolvedValue({ inputs: { channel: {} } });
    const add = jest.fn().mockResolvedValue({ id: 7, finished });
    const queue = new ActionsQueue({ add } as never);

    await expect(queue.runAndWait(job)).resolves.toEqual({
      inputs: { channel: {} },
    });
    // One attempt: a settings form should report a failure, not retry behind
    // the person waiting on it.
    expect(add.mock.calls[0][2].attempts).toBe(1);
  });

  it('gives up waiting rather than hanging a settings form', async () => {
    const add = jest.fn().mockResolvedValue({
      id: 7,
      finished: () => new Promise(() => {}),
    });
    const queue = new ActionsQueue({ add } as never);

    await expect(queue.runAndWait(job, 10)).rejects.toThrow(
      'did not answer in time',
    );
  });
});

describe('running an action', () => {
  it('loads the integration in this process, by slug', async () => {
    const loadIntegration = jest.fn().mockResolvedValue({ message: 'ok' });
    const processor = new ActionsProcessor({ loadIntegration } as never);

    await processor.handleRunAction({ data: job } as never);

    expect(loadIntegration).toHaveBeenCalledWith('discord', {
      event: 'ON_CREATE',
      workspaceId: 'ws-1',
      modelId: 'issue-1',
    });
  });

  /** Rethrown so Bull records the failure and keeps the job findable. */
  it('fails the job when the integration throws', async () => {
    const loadIntegration = jest.fn().mockRejectedValue(new Error('boom'));
    const processor = new ActionsProcessor({ loadIntegration } as never);

    await expect(
      processor.handleRunAction({ data: job } as never),
    ).rejects.toThrow('boom');
  });
});
