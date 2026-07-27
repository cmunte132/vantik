import { describe, expect, it } from 'vitest';

import { type PendingWrite, mergeWrite } from './outbox';

/**
 * The merge is the conflict policy.
 *
 * Field-level last-write-wins was chosen because the window this covers is a
 * hiccup rather than a day: two people editing different fields of one issue
 * both keep their work, and the same field resolves to whoever replays last.
 * Merging also keeps the queue honest about intent — replaying "assign to A"
 * and then "assign to B" as two requests would make the server briefly hold a
 * state the user never asked to keep, which anything watching assignments
 * would see as a real change.
 */
function queued(overrides: Partial<PendingWrite> = {}): PendingWrite {
  return {
    recordId: 'issue-1',
    url: '/api/v1/issues/issue-1?teamId=team-1',
    data: { stateId: 'state-todo' },
    queuedAt: '2026-07-27T10:00:00.000Z',
    attempts: 2,
    ...overrides,
  };
}

describe('mergeWrite', () => {
  it('keeps fields from an earlier edit that the new one does not mention', () => {
    const merged = mergeWrite(queued(), {
      recordId: 'issue-1',
      url: '/api/v1/issues/issue-1?teamId=team-1',
      data: { assigneeId: 'user-2' },
    });

    expect(merged.data).toEqual({
      stateId: 'state-todo',
      assigneeId: 'user-2',
    });
  });

  it('lets the later value win for a field edited twice', () => {
    const merged = mergeWrite(queued({ data: { priority: 1 } }), {
      recordId: 'issue-1',
      url: '/api/v1/issues/issue-1?teamId=team-1',
      data: { priority: 3 },
    });

    expect(merged.data).toEqual({ priority: 3 });
  });

  it('keeps the original queue time so drain order follows the user', () => {
    const merged = mergeWrite(queued(), {
      recordId: 'issue-1',
      url: '/api/v1/issues/issue-1?teamId=team-1',
      data: { title: 'Renamed' },
    });

    expect(merged.queuedAt).toBe('2026-07-27T10:00:00.000Z');
  });

  it('does not hand a failing write a fresh retry budget', () => {
    // Otherwise a write that can never succeed is retried forever, as long as
    // someone keeps editing the record.
    const merged = mergeWrite(queued({ attempts: 19 }), {
      recordId: 'issue-1',
      url: '/api/v1/issues/issue-1?teamId=team-1',
      data: { title: 'Renamed' },
    });

    expect(merged.attempts).toBe(19);
  });

  it('starts clean when nothing was queued for the record', () => {
    const merged = mergeWrite(undefined, {
      recordId: 'issue-2',
      url: '/api/v1/issues/issue-2?teamId=team-1',
      data: { stateId: 'state-done' },
    });

    expect(merged.attempts).toBe(0);
    expect(merged.data).toEqual({ stateId: 'state-done' });
    expect(Date.parse(merged.queuedAt)).not.toBeNaN();
  });
});
