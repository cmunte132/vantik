import { isAlive } from 'mobx-state-tree';
import { describe, expect, it } from 'vitest';

import { syncRecord, syncedStore } from '../test-support/synced-store';

describe('saved view updates', () => {
  it('keeps a rendered view live through a sync update and database reload', async () => {
    const client = syncedStore();
    const store = client.stores.viewsStore;
    await client.apply(syncRecord('View', 'I', {
      id: 'retained-view',
      data: { name: 'Before', filters: { priority: { filterType: 'IS', value: [1] } } },
    }));
    await store.load();
    const renderedView = store.getViewWithId('retained-view');

    await client.apply(syncRecord('View', 'U', {
      id: 'retained-view',
      data: { name: 'After', filters: { priority: { filterType: 'IS', value: [2] } } },
    }));
    await store.load();

    expect(store.getViewWithId('retained-view')).toBe(renderedView);
    expect(isAlive(renderedView)).toBe(true);
    expect(renderedView.name).toBe('After');
    expect([...renderedView.filters.priority.value]).toEqual([2]);
  });
});
