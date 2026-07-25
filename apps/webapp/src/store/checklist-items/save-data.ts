import type { ChecklistItemsStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveChecklistItemData(
  data: SyncActionRecord[],
  checklistItemsStore: ChecklistItemsStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const checklistItem = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        body: record.data.body,
        completed: record.data.completed,
        sortOrder: record.data.sortOrder,

        completedAt: record.data.completedAt,
        completedById: record.data.completedById,

        issueId: record.data.issueId,
        createdById: record.data.createdById,
      };

      switch (record.action) {
        case 'I': {
          await vantikDatabase.checklistItems.put(checklistItem);
          return (
            checklistItemsStore &&
            (await checklistItemsStore.update(checklistItem, record.data.id))
          );
        }

        case 'U': {
          await vantikDatabase.checklistItems.put(checklistItem);
          return (
            checklistItemsStore &&
            (await checklistItemsStore.update(checklistItem, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.checklistItems.delete(record.data.id);
          return (
            checklistItemsStore &&
            (await checklistItemsStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}
