import { types } from 'mobx-state-tree';

export const Cycle = types.model('Cycle', {
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,

  name: types.string,
  description: types.union(types.string, types.null),
  number: types.union(types.number, types.null, types.undefined),
  teamId: types.string,
  startDate: types.union(types.string, types.null),
  endDate: types.union(types.string, types.null),

  // Optional, not a bare `types.string`, because the field is new: every cycle
  // already in a client's IndexedDB was written before `saveCyclesData` mapped
  // it. A schema bump upgrades the indexes and keeps those rows — only a
  // *downgrade* wipes — so a required string here made `load()` throw on the
  // first row and took every cycle with it.
  status: types.union(types.string, types.null, types.undefined),
  closedAt: types.union(types.string, types.null, types.undefined),

  preferences: types.union(types.string, types.null),
});

export const Cycles = types.array(Cycle);
