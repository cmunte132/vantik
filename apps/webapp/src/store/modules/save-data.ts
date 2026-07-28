import type { ModulesStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveModuleData(
  data: SyncActionRecord[],
  modulesStore: ModulesStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const module = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        name: record.data.name,
        key: record.data.key,
        description: record.data.description,
        status: record.data.status,
        icon: record.data.icon,
        color: record.data.color,
        leadUserId: record.data.leadUserId,
        ownerTeamId: record.data.ownerTeamId ?? null,
        ownerProductId: record.data.ownerProductId ?? null,
        linkedTeamIds: record.data.linkedTeamIds ?? [],
        linkedProductIds: record.data.linkedProductIds ?? [],
        workspaceId: record.data.workspaceId,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.modules.put(module);
          return (
            modulesStore && (await modulesStore.update(module, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.modules.delete(record.data.id);
          return (
            modulesStore && (await modulesStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}
