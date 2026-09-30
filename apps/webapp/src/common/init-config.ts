import * as Sentry from '@sentry/react';
import posthog from 'posthog-js';

import { loadClientConfig } from 'common/lib/client-config';

export async function initPosthog() {
  if (typeof window === 'undefined') {
    return;
  }

  const { posthogKey, posthogHost } = await loadClientConfig();

  // No key means analytics are switched off for this install, which is the
  // default for self-hosted.
  if (!posthogKey) {
    return;
  }

  posthog.init(posthogKey, {
    api_host: posthogHost,
    person_profiles: 'identified_only', // or 'always' to create profiles for anonymous users as well
    loaded: (posthog) => {
      if (process.env.NODE_ENV === 'development') {
        posthog.debug();
      } // debug mode in development
    },
  });
}

/**
 * The DSN is an install-time setting fetched from the server, so init happens
 * once that request lands. The tradeoff is that errors thrown in the first few
 * hundred milliseconds of boot go uncaptured; catching those would mean
 * inlining the DSN into the document, which is the build-time coupling this
 * exists to remove. An empty DSN disables the SDK, which is the default for
 * self-hosted.
 */
export async function initSentry() {
  const { sentryDsn } = await loadClientConfig();

  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 1,
    debug: false,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
  });
}
