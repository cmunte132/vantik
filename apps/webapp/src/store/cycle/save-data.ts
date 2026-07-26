import type { CyclesStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveCyclesData(
  data: SyncActionRecord[],
  cyclesStore: CyclesStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const cycle = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,
        name: record.data.name,
        teamId: record.data.teamId,
        description: record.data.description,

        startDate: record.data.startDate,
        endDate: record.data.endDate,
        number: record.data.number,

        // Every control in the cycles list keys off this — which cycle can be
        // started, which can be completed, which may be deleted. Left out of
        // this mapping, the whole list read as one undifferentiated pile.
        status: record.data.status,
        closedAt: record.data.closedAt,

        preferences: JSON.stringify(record.data.preferences),
      };

      switch (record.action) {
        case 'I': {
          await vantikDatabase.cycles.put(cycle);
          return (
            cyclesStore && (await cyclesStore.update(cycle, record.data.id))
          );
        }

        case 'U': {
          await vantikDatabase.cycles.put(cycle);
          return (
            cyclesStore && (await cyclesStore.update(cycle, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.cycles.delete(record.data.id);
          return cyclesStore && (await cyclesStore.deleteById(record.data.id));
        }
      }
    }),
  );
}
