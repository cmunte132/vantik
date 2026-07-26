import { describe, expect, it } from 'vitest';

import { SAVE_HANDLERS } from 'common/wrappers/socket-data-util';

import { VantikDatabase } from './database';
import { MODELS } from './models';

/**
 * A synced model has to be registered in several places that know nothing
 * about each other: the MODELS enum the server is asked for, a Dexie table to
 * hold the rows, and a save handler to put them there. Miss one and the model
 * fails quietly — the records arrive over the socket and are dropped on the
 * floor, which reads as "the feature does not work" long after the change that
 * caused it.
 */

/**
 * Models the client asks for but does not store. Bootstrap requests every
 * member of the enum, so a name can be in the enum without having a table.
 */
const NOT_STORED_LOCALLY: Partial<Record<MODELS, string>> = {
  [MODELS.IntegrationDefinition]:
    'read from the API on demand, never held in the local database',
};

const storedModels = Object.values(MODELS).filter(
  (model) => !(model in NOT_STORED_LOCALLY),
);

// Dexie builds its schema in the constructor, and reading `tables` back does
// not need a real IndexedDB, so the definition can be inspected directly.
const tableNames = new Set(
  new VantikDatabase('registry-spec').tables.map((table) => table.name),
);

describe('synced models are registered everywhere', () => {
  it.each(storedModels)('%s has a Dexie table', (model) => {
    expect(
      tableNames.has(model),
      `${model} is synced but has no table in VantikDatabase, so its records ` +
        `are fetched and then discarded. Add it to the stores() definition ` +
        `and bump the schema version.`,
    ).toBe(true);
  });

  it.each(storedModels)('%s has a save handler', (model) => {
    expect(
      Object.hasOwn(SAVE_HANDLERS, model),
      `${model} is synced but SAVE_HANDLERS has no entry for it, so records ` +
        `arriving over the socket are silently dropped.`,
    ).toBe(true);
  });

  it('has no Dexie table without a model to fill it', () => {
    const knownModels = new Set<string>(Object.values(MODELS));
    const orphans = [...tableNames].filter((name) => !knownModels.has(name));

    expect(orphans).toEqual([]);
  });
});
