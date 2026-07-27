import type { WorkspaceStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';
import { MODELS } from 'store/models';

export async function saveWorkspaceData(
  data: SyncActionRecord[],
  workspaceStore: WorkspaceStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      // Every other model's handler branches on the action; this one never
      // did, so a delete was applied as an upsert. That put the membership
      // straight back after someone was removed, and — once deletes started
      // arriving with only an id, which is all a delete can carry — pushed a
      // record with no fields into the store, where MST refused it and took
      // the page down.
      if (record.action === 'D') {
        if (record.modelName === MODELS.UsersOnWorkspaces) {
          await vantikDatabase.usersOnWorkspaces.delete(record.data.id);

          return workspaceStore && workspaceStore.deleteUser(record.data.id);
        }

        // A deleted workspace is not something this store can meaningfully
        // switch away from — the routes and every other store are built around
        // the current one — so the cached copy goes and the redirect is left to
        // the next request, which will fail its workspace check.
        return await vantikDatabase.workspaces.delete(record.data.id);
      }

      if (record.modelName === MODELS.UsersOnWorkspaces) {
        const userOnWorkspace = {
          id: record.data.id,
          createdAt: record.data.createdAt,
          updatedAt: record.data.updatedAt,
          userId: record.data.userId,
          workspaceId: record.data.workspaceId,
          teamIds: record.data.teamIds,
          role: record.data.role,
          status: record.data.status,
          settings: record.data.settings,
        };

        await vantikDatabase.usersOnWorkspaces.put(userOnWorkspace);

        // Update the store
        return (
          workspaceStore &&
          (await workspaceStore.updateUsers(userOnWorkspace, record.data.id))
        );
      }

      const workspace = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,
        name: record.data.name,
        actionsEnabled: record.data.actionsEnabled,
        preferences: record.data.preferences,
        slug: record.data.slug,
      };

      await vantikDatabase.workspaces.put(workspace);

      // Update the store
      return workspaceStore && (await workspaceStore.update(workspace));
    }),
  );
}
