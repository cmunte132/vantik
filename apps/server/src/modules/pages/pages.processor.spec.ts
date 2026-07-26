/**
 * The schedule behind the decay pass.
 *
 * `runDecay` is tested in page-entries.service.spec.ts — what is tested here is
 * that something actually calls it, on a schedule that is singular across
 * replicas and can be changed or turned off without leaving a stale one behind.
 * A dormant decay pass is the failure this file exists to catch: the arithmetic
 * can be perfect and the bank still grows without bound.
 */
import { Queue } from 'bull';

import PageEntriesService from './page-entries.service';
import { DECAY_JOB, DECAY_JOB_ID } from './pages.interface';
import { PagesProcessor, PagesScheduler } from './pages.processor';

function buildQueue(existing: Array<{ name: string; key: string }> = []) {
  return {
    getRepeatableJobs: jest.fn(() => Promise.resolve(existing)),
    removeRepeatableByKey: jest.fn(() => Promise.resolve()),
    add: jest.fn(() => Promise.resolve()),
  } as unknown as Queue & {
    getRepeatableJobs: jest.Mock;
    removeRepeatableByKey: jest.Mock;
    add: jest.Mock;
  };
}

describe('PagesScheduler', () => {
  it('registers the decay pass under a fixed id', async () => {
    const queue = buildQueue();

    await new PagesScheduler(queue).onModuleInit();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, , options] = queue.add.mock.calls[0];
    expect(name).toBe(DECAY_JOB);
    expect(options.repeat.cron).toBeTruthy();
    // Every replica registers at boot; without a stable id each adds its own
    // copy and the pass runs once per replica per night.
    expect(options.jobId).toBe(DECAY_JOB_ID);
  });

  it('clears the previous schedule before registering, so the cron is changeable', async () => {
    const queue = buildQueue([
      { name: DECAY_JOB, key: 'old-key' },
      { name: 'somethingElse', key: 'other-key' },
    ]);

    await new PagesScheduler(queue).onModuleInit();

    // Bull keys a repeatable job by its cron expression, so changing
    // PAGE_DECAY_CRON without this leaves the old schedule registered too.
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('old-key');
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalledWith('other-key');
  });

  it('does not stop the server coming up when the queue is unreachable', async () => {
    const queue = buildQueue();
    queue.getRepeatableJobs.mockRejectedValue(new Error('redis is down'));

    // Matching the vector collections: setup that fails degrades the feature
    // rather than taking the deployment with it.
    await expect(new PagesScheduler(queue).onModuleInit()).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('PagesProcessor', () => {
  it('runs decay across every workspace', async () => {
    const runDecay = jest.fn(() =>
      Promise.resolve({ expiredProposed: 3, archivedStanding: 1 }),
    );
    const service = { runDecay } as unknown as PageEntriesService;

    await new PagesProcessor(service).handleDecay();

    // Unscoped deliberately: the windows are a property of the deployment, not
    // of any one workspace.
    expect(runDecay).toHaveBeenCalledWith();
  });
});
