import { types } from 'mobx-state-tree';

export const PageEntry = types.model({
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,

  content: types.string,
  scope: types.union(types.string, types.null, types.undefined),
  /** The modules the scope resolves to, kept by the server. */
  moduleIds: types.optional(types.array(types.string), []),
  kind: types.union(types.string, types.null, types.undefined),
  status: types.string,

  sourceUserId: types.union(types.string, types.null, types.undefined),
  sourceSession: types.union(types.string, types.null, types.undefined),

  verifiedByUserId: types.union(types.string, types.null, types.undefined),
  verifiedAt: types.union(types.string, types.null, types.undefined),

  retrievalCount: types.number,
  lastServedAt: types.union(types.string, types.null, types.undefined),

  supersedesId: types.union(types.string, types.null, types.undefined),
  pageId: types.string,
});

export const PageEntryArray = types.array(PageEntry);
