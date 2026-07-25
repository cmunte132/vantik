import { types } from 'mobx-state-tree';

export const Page = types.model({
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,

  title: types.string,
  description: types.union(types.string, types.null, types.undefined),
  parentId: types.union(types.string, types.null, types.undefined),
  sortOrder: types.union(types.number, types.null, types.undefined),

  entryPolicy: types.string,
  visibility: types.string,

  workspaceId: types.string,
  createdById: types.union(types.string, types.null, types.undefined),
  updatedById: types.union(types.string, types.null, types.undefined),
});

export const PagesMap = types.map(Page);
