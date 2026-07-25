import { types } from 'mobx-state-tree';

export const ChecklistItem = types.model({
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,

  body: types.string,
  completed: types.boolean,
  sortOrder: types.union(types.number, types.null, types.undefined),

  completedAt: types.union(types.string, types.null, types.undefined),
  completedById: types.union(types.string, types.null, types.undefined),

  issueId: types.string,
  createdById: types.union(types.string, types.null, types.undefined),
});

export const ChecklistItemArray = types.array(ChecklistItem);
