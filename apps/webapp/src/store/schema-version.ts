/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * The Dexie schema version this bundle ships.
 *
 * Kept in its own module, free of the Dexie import, so the /api/version route
 * can report it without dragging the whole client database into the server
 * bundle.
 *
 * Bump this in step with the `this.version(n)` call in database.ts — adding a
 * synced model means both. A client whose stored data was written by a *newer*
 * schema than this cannot be migrated backwards and gets wiped and re-synced
 * instead; see `reconcileSchemaVersion`.
 */
export const DEXIE_SCHEMA_VERSION = 22;
