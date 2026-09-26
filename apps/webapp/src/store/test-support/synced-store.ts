import { getSnapshot } from 'mobx-state-tree';

import type { SyncActionRecord } from 'common/types';
import {
  modelStoreMap,
  saveSocketData,
} from 'common/wrappers/socket-data-util';

import { initDatabase, vantikDatabase } from 'store/database';
import { createStoreContext } from 'store/global-context-provider';

import { getPrismaModel, parsePrismaEnums } from './prisma-schema';

/**
 * The client's sync path, run for real in Node: records go through the same
 * save handlers the bootstrap, the delta and the socket use, into a real
 * IndexedDB (fake-indexeddb, installed for every test by vitest.config.ts)
 * and a real MobX-State-Tree root store.
 */

let databases = 0;

/**
 * A fresh local database and root store. Each call gets its own database, so
 * no test sees another's rows.
 */
export function syncedStore() {
  databases += 1;
  initDatabase(Date.now() * 1000 + databases);

  const stores = createStoreContext();
  const map = modelStoreMap(stores);

  return {
    stores,
    /** The store a model's records are saved into. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeFor: (model: string): any => map[model as keyof typeof map],
    /** Saves records exactly as the socket does. */
    apply: async (...records: SyncActionRecord[]) => {
      await saveSocketData(records, map);
    },
    /** The row a model's Dexie table holds for `id`. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: (model: string, id: string): Promise<any> =>
      vantikDatabase.table(model).get(id),
  };
}

/** Whether a store holds a record with this id, wherever it keeps it. */
export function storeHolds(store: unknown, id: string): boolean {
  return JSON.stringify(getSnapshot(store as object)).includes(`"${id}"`);
}

let sequence = 0;

const enums = parsePrismaEnums();

/** A value of a column's type, distinct enough to notice if it goes missing. */
function valueFor(field: { name: string; type: string }, id: string): unknown {
  if (field.name === 'id') {
    return id;
  }

  const enumValues = enums.get(field.type);
  if (enumValues) {
    return enumValues[0];
  }

  switch (field.type) {
    case 'String':
      return field.name.endsWith('Id') ? `${field.name}-1` : `${field.name}!`;
    case 'DateTime':
      return '2026-01-02T03:04:05.000Z';
    case 'Boolean':
      return true;
    case 'Int':
      return 7;
    case 'Float':
    case 'Decimal':
      return 7.5;
    case 'BigInt':
      return '7';
    case 'Json':
      return { [field.name]: 'json' };
    default:
      return undefined;
  }
}

/**
 * A sync record for `model` as the server sends it: every column of the row in
 * `data`, filled from schema.prisma. `nulls` sets every nullable column to
 * null instead, the way a freshly created row usually arrives.
 */
export function syncRecord(
  model: string,
  action: 'I' | 'U' | 'D',
  options: {
    id?: string;
    nulls?: boolean;
    data?: Record<string, unknown>;
  } = {},
): SyncActionRecord {
  sequence += 1;
  const id = options.id ?? `${model.toLowerCase()}-${sequence}`;

  const data: Record<string, unknown> = {};
  for (const field of getPrismaModel(model).fields) {
    if (options.nulls && field.isOptional && field.name !== 'id') {
      data[field.name] = null;
      continue;
    }

    const value = valueFor(field, id);
    data[field.name] = field.isList
      ? value === undefined
        ? []
        : [value]
      : value;
  }

  // A row that is not deleted says so with a null, whatever the fill above
  // chose; a delete is what carries a timestamp.
  if ('deleted' in data) {
    data.deleted = action === 'D' ? '2026-01-02T03:04:05.000Z' : null;
  }

  return {
    // The type is a const enum the module does not export.
    action: action as SyncActionRecord['action'],
    modelName: model,
    modelId: id,
    workspaceId: 'workspaceId-1',
    sequenceId: `${sequence}`,
    data: { ...data, ...options.data },
  };
}
