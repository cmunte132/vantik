/** Copyright (c) 2024, Vantik, all rights reserved. **/

import type { NextApiRequest, NextApiResponse } from 'next';

import { DEXIE_SCHEMA_VERSION } from 'store/schema-version';

export interface VersionResponse {
  buildId: string;
  commit: string;
  builtAt: string;
  /**
   * The local-database schema the *serving* build expects. A client reads it
   * for information only; the wipe-or-migrate decision is taken client-side
   * against its own bundled value, so the server can never force a reset.
   */
  dexieSchemaVersion: number;
}

/**
 * What is being served right now.
 *
 * This route is deliberately local. Every other /api/* path is proxied to the
 * backend by [...path].js, but Next resolves a concrete filename ahead of a
 * catch-all, so this one is answered by the same process that serves the
 * bundle. That is the whole point: a version served by any other process could
 * disagree with the assets on disk, and this endpoint is the tie-breaker the
 * other detection paths defer to.
 */
export default function handler(
  _req: NextApiRequest,
  res: NextApiResponse<VersionResponse>,
) {
  // Also set in next.config.js headers(), repeated here because this answer in
  // particular must never come from a cache.
  res.setHeader('Cache-Control', 'no-store');

  res.status(200).json({
    buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? 'unknown',
    commit: process.env.NEXT_PUBLIC_BUILD_COMMIT ?? 'unknown',
    builtAt: process.env.NEXT_PUBLIC_BUILT_AT ?? '',
    dexieSchemaVersion: DEXIE_SCHEMA_VERSION,
  });
}
