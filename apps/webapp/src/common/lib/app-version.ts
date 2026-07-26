/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * Which build this client is, and what the server is serving.
 *
 * The two can differ for a long time. An installed PWA window stays open for
 * days, so after a deploy it keeps running the bundle it started with, asking
 * for chunks under a /_next/static/<buildId>/ prefix that no longer exists.
 * Everything here exists to notice that, cheaply and from several directions.
 */

import { DEXIE_SCHEMA_VERSION } from 'store/schema-version';

/**
 * Inlined by next.config.js `env` at build time. Not read from the container's
 * environment on purpose — it names the bundle the browser is running, which is
 * a build-time fact, unlike the settings served by /api/v1/config.
 */
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? 'unknown';
export const BUILD_COMMIT = process.env.NEXT_PUBLIC_BUILD_COMMIT ?? 'unknown';
export const BUILT_AT = process.env.NEXT_PUBLIC_BUILT_AT ?? '';

/** The header every webapp response carries, including the /api/* proxy's. */
export const BUILD_HEADER = 'x-vantik-build';

/**
 * The server image's own stamp. Reported for visibility only — an old client is
 * never refused, so this exists to make skew observable, not to gate anything.
 */
export const SERVER_BUILD_HEADER = 'x-vantik-server-build';

/**
 * In development the stamp is the fixed string 'dev', so there is nothing to
 * compare and the whole mechanism stays out of the way of HMR.
 */
export const VERSION_TRACKING_ENABLED = BUILD_ID !== 'dev';

export interface ServedVersion {
  buildId: string;
  commit: string;
  builtAt: string;
  dexieSchemaVersion: number;
}

/**
 * Asks the process that serves the bundle what it is serving.
 *
 * This is the authority. The header and socket paths are faster but indirect,
 * so both defer to this before anything is shown to the user.
 */
export async function fetchServedVersion(): Promise<ServedVersion | undefined> {
  try {
    const response = await fetch('/api/version', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return undefined;
    }

    return (await response.json()) as ServedVersion;
  } catch {
    // Offline, or mid-restart. Silent: the poll will come back round, and a
    // failed version check is not something to put in front of a user.
    return undefined;
  }
}

/**
 * Whether `served` names a different build than the one running.
 *
 * Unknown values are never treated as stale — a missing header or a failed
 * fetch must not produce a reload prompt.
 */
export function isDifferentBuild(served: string | undefined | null): boolean {
  if (!VERSION_TRACKING_ENABLED || !served || served === 'unknown') {
    return false;
  }

  return served !== BUILD_ID;
}

/** For the debug surface and for reporting; not used in any decision. */
export function describeClientBuild() {
  return {
    buildId: BUILD_ID,
    commit: BUILD_COMMIT,
    builtAt: BUILT_AT,
    dexieSchemaVersion: DEXIE_SCHEMA_VERSION,
  };
}
