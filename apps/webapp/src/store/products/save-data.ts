import type { ProductsStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveProductData(
  data: SyncActionRecord[],
  productsStore: ProductsStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const product = {
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
        workspaceId: record.data.workspaceId,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.products.put(product);
          return (
            productsStore &&
            (await productsStore.update(product, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.products.delete(record.data.id);
          return (
            productsStore && (await productsStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}
