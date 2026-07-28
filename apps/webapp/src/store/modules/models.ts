import { types } from 'mobx-state-tree';

export const ProductModule = types.model('Module', {
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,
  name: types.string,
  key: types.string,
  description: types.union(types.string, types.null),
  status: types.union(types.string, types.null),
  icon: types.union(types.string, types.null),
  color: types.union(types.string, types.null),
  leadUserId: types.union(types.string, types.null),
  // Exactly one of these holds a value. The database says so with a check
  // constraint, and the settings form refuses to send anything else.
  ownerTeamId: types.union(types.string, types.null),
  ownerProductId: types.union(types.string, types.null),
  linkedTeamIds: types.optional(types.array(types.string), []),
  linkedProductIds: types.optional(types.array(types.string), []),
  workspaceId: types.string,
});
