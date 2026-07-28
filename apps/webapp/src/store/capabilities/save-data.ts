import type { CapabilitiesStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveCapabilityData(
  data: SyncActionRecord[],
  capabilitiesStore: CapabilitiesStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const capability = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        name: record.data.name,
        description: record.data.description,
        status: record.data.status,
        moduleIds: record.data.moduleIds ?? [],
        workspaceId: record.data.workspaceId,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.capabilities.put(capability);
          return (
            capabilitiesStore &&
            (await capabilitiesStore.update(capability, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.capabilities.delete(record.data.id);
          return (
            capabilitiesStore &&
            (await capabilitiesStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}
