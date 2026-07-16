import type { LinkedIssuesStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveLinkedIssueData(
  data: SyncActionRecord[],
  linkedIssuesStore: LinkedIssuesStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const linkedIssue = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        url: record.data.url,
        sourceId: record.data.sourceId,
        source: JSON.stringify(record.data.source),
        sourceData: JSON.stringify(record.data.sourceData),
        issueId: record.data.issueId,
        createdById: record.data.createdById,
      };

      switch (record.action) {
        case 'I': {
          await vantikDatabase.linkedIssues.put(linkedIssue);
          return (
            linkedIssuesStore &&
            (await linkedIssuesStore.update(linkedIssue, record.data.id))
          );
        }

        case 'U': {
          await vantikDatabase.linkedIssues.put(linkedIssue);
          return (
            linkedIssuesStore &&
            (await linkedIssuesStore.update(linkedIssue, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.linkedIssues.delete(record.data.id);
          return (
            linkedIssuesStore &&
            (await linkedIssuesStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}
