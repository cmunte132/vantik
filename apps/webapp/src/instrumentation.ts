/** Copyright (c) 2024, Vantik, all rights reserved. **/

import * as Sentry from '@sentry/nextjs';

// Sentry must be initialised from an instrumentation file so that it loads
// before any other server code. The runtime check keeps the edge bundle free of
// the Node SDK and vice versa.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
