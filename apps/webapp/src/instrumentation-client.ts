// This file configures the initialization of Sentry on the client.
// The config you add here will be used whenever a user loads a page in their browser.
// Next.js loads it as the client instrumentation hook; the old
// `sentry.client.config.ts` name stops working under Turbopack.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';

import { loadClientConfig } from 'common/lib/client-config';

// The DSN is an install-time setting fetched from the server, so init happens
// once that request lands. The tradeoff is that errors thrown in the first few
// hundred milliseconds of boot go uncaptured; catching those would mean
// inlining the DSN into the document, which is the build-time coupling this
// change exists to remove.
// An empty DSN disables the SDK, which is the default for self-hosted.
void loadClientConfig().then(({ sentryDsn }) => {
  Sentry.init({
    dsn: sentryDsn,

    environment: process.env.NODE_ENV,

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: 1,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,

    replaysOnErrorSampleRate: 1.0,

    // This sets the sample rate to be 10%. You may want this to be 100% while
    // in development and sample at a lower rate in production
    replaysSessionSampleRate: 0.1,
  });
});

// Lets Sentry tie spans to client-side route changes.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
