import type { TemplateStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveTemplateData(
  data: SyncActionRecord[],
  templatesStore: TemplateStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const template = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,
        name: record.data.name,
        category: record.data.category,
        templateData: JSON.stringify(record.data.templateData),
        workspaceId: record.data.workspaceId,
        teamId: record.data.teamId,
      };

      switch (record.action) {
        case 'I': {
          await vantikDatabase.templates.put(template);
          return (
            templatesStore &&
            (await templatesStore.update(template, record.data.id))
          );
        }

        case 'U': {
          await vantikDatabase.templates.put(template);
          return (
            templatesStore &&
            (await templatesStore.update(template, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.templates.delete(record.data.id);
          return (
            templatesStore && (await templatesStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}
