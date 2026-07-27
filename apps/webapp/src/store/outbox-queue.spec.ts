import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();

vi.mock('services/utils', () => ({ ajaxPost: (...args: unknown[]) => post(...args) }));

const { initOutbox, pendingWrites, queueWrite } = await import('./outbox');
const { drainOutbox } = await import('./outbox-drain');

/**
 * The queue as a whole: what goes in when a write fails, what comes out when
 * the server returns, and what happens to a write that can never succeed.
 *
 * Run against a real IndexedDB implementation rather than a hand-written fake,
 * because the parts worth testing here — the merge on the primary key, the
 * ordering, the deletion after a successful send — are the storage layer's
 * behaviour as much as this module's.
 */
const ISSUE = 'issue-1';
const URL = '/api/v1/issues/issue-1?teamId=team-1';

describe('the outbox, end to end', () => {
  beforeEach(async () => {
    post.mockReset();
    // A fresh database per test: leftovers would make ordering assertions
    // depend on which test ran first.
    initOutbox(Math.floor(Math.random() * 1e9));
  });

  it('sends a queued write and forgets it', async () => {
    post.mockResolvedValue({});
    await queueWrite({ recordId: ISSUE, url: URL, data: { priority: 1 } });

    const result = await drainOutbox();

    expect(result).toEqual({ sent: 1, abandoned: 0, stalled: false });
    expect(post).toHaveBeenCalledWith({ url: URL, data: { priority: 1 } });
    expect(await pendingWrites()).toHaveLength(0);
  });

  it('sends one request for repeated edits to the same record', async () => {
    post.mockResolvedValue({});
    await queueWrite({ recordId: ISSUE, url: URL, data: { priority: 1 } });
    await queueWrite({ recordId: ISSUE, url: URL, data: { assigneeId: 'u-2' } });
    await queueWrite({ recordId: ISSUE, url: URL, data: { priority: 3 } });

    await drainOutbox();

    // Merged, not replayed in sequence: the server never sees priority 1, a
    // state the user did not ask to keep.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({
      url: URL,
      data: { priority: 3, assigneeId: 'u-2' },
    });
  });

  it('keeps the write and stops when the network is still down', async () => {
    post.mockRejectedValue({ status: 0 });
    await queueWrite({ recordId: ISSUE, url: URL, data: { priority: 1 } });
    await queueWrite({ recordId: 'issue-2', url: URL, data: { priority: 2 } });

    const result = await drainOutbox();

    expect(result.stalled).toBe(true);
    expect(result.sent).toBe(0);
    // Both survive, and the second was not attempted out of order.
    expect(await pendingWrites()).toHaveLength(2);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('drops a write the server has already refused', async () => {
    // Retrying a 400 forever would hide the refusal behind a write that looks
    // like it is still on its way.
    post.mockRejectedValue({ status: 400 });
    await queueWrite({ recordId: ISSUE, url: URL, data: { priority: 9 } });

    const result = await drainOutbox();

    expect(result.abandoned).toBe(1);
    expect(await pendingWrites()).toHaveLength(0);
  });

  it('resumes after the connection comes back', async () => {
    post.mockRejectedValueOnce({ status: 0 }).mockResolvedValue({});
    await queueWrite({ recordId: ISSUE, url: URL, data: { priority: 1 } });

    expect((await drainOutbox()).stalled).toBe(true);
    expect(await pendingWrites()).toHaveLength(1);

    expect((await drainOutbox()).sent).toBe(1);
    expect(await pendingWrites()).toHaveLength(0);
  });
});
