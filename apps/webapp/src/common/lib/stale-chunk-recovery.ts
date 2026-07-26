/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * Last resort: recover a client whose chunks are already gone.
 *
 * This runs independently of version detection, and has to. By the time a
 * dynamic import 404s, the client is not "possibly stale" — it is broken, and
 * the route the user asked for will not render at all. The only useful response
 * is to reload immediately, without waiting for a poll or a prompt.
 *
 * The guard against reload loops is the important part. If a deploy is
 * genuinely broken, a naive handler here would spin the page forever and make
 * diagnosing it impossible.
 */

import Router from 'next/router';

import { BUILD_ID } from './app-version';

const ATTEMPT_KEY = 'vantik:stale-chunk-reload';

/**
 * One reload per build. A second failure against the same build id is not
 * staleness — it is a real bug in that build, and it must be allowed to surface
 * as an error rather than as an infinite refresh.
 */
const MAX_ATTEMPTS = 1;

interface Attempts {
  buildId: string;
  count: number;
}

let installed = false;

function readAttempts(): Attempts {
  try {
    const raw = sessionStorage.getItem(ATTEMPT_KEY);

    if (raw) {
      const parsed = JSON.parse(raw) as Attempts;

      // A different build id means the reload worked and this counter is
      // history.
      if (parsed.buildId === BUILD_ID) {
        return parsed;
      }
    }
  } catch {
    // Unparseable or unavailable: treat as no attempts, but the write below
    // will fail too, so MAX_ATTEMPTS degrades to "reload every time". That is
    // still better than a permanently broken window, and sessionStorage being
    // unavailable at all is not a state this app runs in.
  }

  return { buildId: BUILD_ID, count: 0 };
}

function isStaleChunkError(value: unknown): boolean {
  if (!value) {
    return false;
  }

  const name = (value as Error).name ?? '';
  const message = (value as Error).message ?? '';

  // ChunkLoadError is webpack's; Turbopack and native ESM report a failed
  // dynamic import as a TypeError with a message naming the module, so match on
  // both rather than on one builder's error type.
  return (
    name === 'ChunkLoadError' ||
    /Loading chunk \S+ failed/i.test(message) ||
    /Loading CSS chunk/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message)
  );
}

function recover(reason: string) {
  const attempts = readAttempts();

  if (attempts.count >= MAX_ATTEMPTS) {
    // eslint-disable-next-line no-console
    console.error(
      `[vantik] chunk load failed again on build ${BUILD_ID} (${reason}); not reloading further`,
    );
    return;
  }

  try {
    sessionStorage.setItem(
      ATTEMPT_KEY,
      JSON.stringify({ buildId: BUILD_ID, count: attempts.count + 1 }),
    );
  } catch {
    // See readAttempts.
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[vantik] assets for build ${BUILD_ID} are gone (${reason}); reloading onto the current build`,
  );

  // Deliberately not the guarded reload path: nothing is worth preserving in a
  // window that cannot load its own code, and `true` is meaningless to modern
  // browsers but harmless.
  window.location.reload();
}

/**
 * Installs the handlers. Idempotent, and a no-op on the server.
 */
export function installStaleChunkRecovery() {
  if (installed || typeof window === 'undefined') {
    return;
  }

  installed = true;

  window.addEventListener('error', (event) => {
    if (isStaleChunkError(event.error)) {
      recover('window.error');
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (isStaleChunkError(event.reason)) {
      recover('unhandledrejection');
    }
  });

  // Next's own signal. A client whose build was replaced hits this on the first
  // navigation, before any component gets a chance to throw.
  Router.events.on('routeChangeError', (error: Error) => {
    if (isStaleChunkError(error)) {
      recover('routeChangeError');
    }
  });
}
