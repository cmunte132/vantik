import { types } from 'mobx-state-tree';

export const IntegrationAccount = types.model({
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,
  accountId: types.union(types.string, types.null),
  settings: types.union(types.string, types.null),
  integratedById: types.string,
  personal: types.boolean,
  integrationDefinitionId: types.string,
  workspaceId: types.string,
});
