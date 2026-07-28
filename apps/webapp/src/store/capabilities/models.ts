import { types } from 'mobx-state-tree';

export const Capability = types.model('Capability', {
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,
  name: types.string,
  description: types.union(types.string, types.null),
  status: types.union(types.string, types.null),
  // A capability with an empty list is one that nobody built yet. It appears in
  // the workspace list and under no product.
  moduleIds: types.optional(types.array(types.string), []),
  workspaceId: types.string,
});
