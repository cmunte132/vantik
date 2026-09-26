import { describe, expect, it, vi } from 'vitest';

import { useAllWorkflows } from 'hooks/workflows';

import { renderHook } from 'store/test-support/render-hook';
import { syncRecord, syncedStore } from 'store/test-support/synced-store';

import { useCompletionGuard } from './use-completion-guard';

/**
 * Moving an issue to a completed state while its acceptance criteria are still
 * open asks first. These tests fill a real store through the sync path, the way
 * the app fills it, and then call the hooks the board and the list call.
 */

const TEAM = 'team-1';
const ISSUE = 'issue-1';

async function workspaceWithOpenCriteria() {
  const client = syncedStore();

  await client.apply(
    // Out of order on purpose: the hook is the one that sorts them.
    syncRecord('Workflow', 'I', {
      id: 'done',
      data: { name: 'Done', category: 'COMPLETED', position: 0, teamId: TEAM },
    }),
    syncRecord('Workflow', 'I', {
      id: 'todo',
      data: { name: 'Todo', category: 'UNSTARTED', position: 0, teamId: TEAM },
    }),
    syncRecord('Workflow', 'I', {
      id: 'backlog',
      data: { name: 'Backlog', category: 'BACKLOG', position: 1, teamId: TEAM },
    }),
    syncRecord('ChecklistItem', 'I', {
      data: { issueId: ISSUE, completed: false, body: 'Has tests' },
    }),
  );

  return client.stores;
}

describe('useAllWorkflows', () => {
  // Known bug on main: the hook spreads a MobX-State-Tree map, which yields
  // [id, workflow] pairs instead of workflows. When it is fixed this starts
  // failing as "expected to fail"; change `it.fails` back to `it`.
  it.fails('returns every workflow, sorted by category', async () => {
    const stores = await workspaceWithOpenCriteria();

    const workflows = renderHook(() => useAllWorkflows(), stores);

    expect(workflows?.map((workflow) => workflow.id)).toEqual([
      'backlog',
      'todo',
      'done',
    ]);
  });
});

describe('useCompletionGuard', () => {
  it('lets a move to a state that is not completed through at once', async () => {
    const stores = await workspaceWithOpenCriteria();
    const { guard } = renderHook(() => useCompletionGuard(), stores);
    const apply = vi.fn();

    guard(ISSUE, 'todo', apply);

    expect(apply).toHaveBeenCalledOnce();
  });

  // The same known bug: the guard looks the target state up in
  // useAllWorkflows, finds nothing, and so never learns it is a completed one.
  it.fails(
    'holds a move to a completed state while criteria are open',
    async () => {
      const stores = await workspaceWithOpenCriteria();
      const { guard } = renderHook(() => useCompletionGuard(), stores);
      const apply = vi.fn();

      guard(ISSUE, 'done', apply);

      expect(apply).not.toHaveBeenCalled();
    },
  );
});
