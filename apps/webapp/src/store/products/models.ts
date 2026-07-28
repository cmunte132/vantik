import { types } from 'mobx-state-tree';

export const Product = types.model('Product', {
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,
  name: types.string,
  key: types.string,
  description: types.union(types.string, types.null),
  // Nullable on the server, so it has to be nullable here. One row with a null
  // field fails the type check for the whole array, and the store then holds no
  // products at all.
  status: types.union(types.string, types.null),
  icon: types.union(types.string, types.null),
  color: types.union(types.string, types.null),
  leadUserId: types.union(types.string, types.null),
  workspaceId: types.string,
});
