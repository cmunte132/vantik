import type { PageEntriesStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function savePageEntryData(
  data: SyncActionRecord[],
  pageEntriesStore: PageEntriesStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const entry = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        content: record.data.content,
        scope: record.data.scope,
        status: record.data.status,

        sourceUserId: record.data.sourceUserId,
        sourceSession: record.data.sourceSession,

        verifiedByUserId: record.data.verifiedByUserId,
        verifiedAt: record.data.verifiedAt,

        retrievalCount: record.data.retrievalCount ?? 0,
        lastServedAt: record.data.lastServedAt,

        supersedesId: record.data.supersedesId,
        pageId: record.data.pageId,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.pageEntries.put(entry);
          return (
            pageEntriesStore &&
            (await pageEntriesStore.update(entry, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.pageEntries.delete(record.data.id);
          return (
            pageEntriesStore &&
            (await pageEntriesStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}
