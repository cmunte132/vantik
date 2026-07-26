import { types } from 'mobx-state-tree';

export const Team = types.model({
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,
  name: types.string,

  identifier: types.string,
  workspaceId: types.string,
  currentCycle: types.union(types.number, types.null, types.undefined),
  preferences: types.model({
    cyclesEnabled: types.union(types.boolean, types.undefined, types.null),
    cyclesMode: types.union(types.string, types.undefined, types.null),
    cyclesFrequency: types.union(types.number, types.undefined, types.null),
    upcomingCycles: types.union(types.number, types.undefined, types.null),
    teamType: types.union(types.string, types.undefined, types.null),
  }),
});

export const Teams = types.array(Team);
