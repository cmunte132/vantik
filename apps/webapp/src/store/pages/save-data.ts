import type { PagesStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function savePageData(
  data: SyncActionRecord[],
  pagesStore: PagesStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const page = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        title: record.data.title,
        description: record.data.description,
        parentId: record.data.parentId,
        sortOrder: record.data.sortOrder,

        entryPolicy: record.data.entryPolicy,
        visibility: record.data.visibility,

        workspaceId: record.data.workspaceId,
        createdById: record.data.createdById,
        updatedById: record.data.updatedById,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.pages.put(page);
          return pagesStore && (await pagesStore.update(page, record.data.id));
        }

        case 'D': {
          await vantikDatabase.pages.delete(record.data.id);
          return pagesStore && (await pagesStore.deleteById(record.data.id));
        }
      }
    }),
  );
}
