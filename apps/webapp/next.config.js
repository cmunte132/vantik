/** Copyright (c) 2024, Vantik, all rights reserved. **/

const { resolveBuildStamp } = require('./build-id');

const { buildId, commit, builtAt } = resolveBuildStamp();

module.exports = {
  reactStrictMode: false,
  // Pins the chunk namespace to the commit instead of Next's random default, so
  // an unchanged rebuild keeps its /_next/static/<buildId>/ URLs and does not
  // 404 the chunks of clients that are already open.
  generateBuildId: () => buildId,
  // Inlined rather than read from the environment: this identifies the bundle
  // the browser is running, so unlike the settings served by /api/v1/config it
  // must not follow the container it happens to be served from.
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
    NEXT_PUBLIC_BUILD_COMMIT: commit,
    NEXT_PUBLIC_BUILT_AT: builtAt ?? '',
  },
  transpilePackages: ['geist', '@vantikhq/ui', 'react-day-picker', 'date-fns'],
  async redirects() {
    return [
      {
        source: '/',
        destination: '/auth',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        // matching all API routes
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: '*' }, // replace this your actual origin
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET,DELETE,PATCH,POST,PUT',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value:
              'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version',
          },
        ],
      },
      {
        // The build stamp rides on every response, including the /api/* proxy's
        // (which is why the CORS block above is proof this applies to the
        // catch-all proxy route). A client compares it against its own inlined
        // id and learns it is stale without spending a request to ask —
        // including on the very request that is about to fail because it is.
        source: '/:path*',
        headers: [{ key: 'X-Vantik-Build', value: buildId }],
      },
      {
        // Documents only. Matching on Accept is what separates a navigation
        // from a chunk or JSON fetch, so the immutable, content-hashed assets
        // under /_next/static keep their year-long cache while the shell that
        // references them is always revalidated. Serving a stale shell is how a
        // client ends up asking for chunks that no longer exist.
        source: '/:path*',
        has: [{ type: 'header', key: 'accept', value: '.*text/html.*' }],
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
        ],
      },
      {
        // The worker and the manifest are the two files a browser will
        // otherwise hold for up to 24h, which would pin a client to whichever
        // build first registered them.
        source: '/:file(sw.js|manifest.webmanifest)',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
        ],
      },
      {
        // The authority for "what is being served now" cannot itself be
        // cacheable, or the answer could come from the build being replaced.
        source: '/api/version',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
  devIndicators: {
    position: 'bottom-right',
  },
  // Runtime settings are served from /api/v1/config, not baked in here.
  // publicRuntimeConfig is removed in Next 16 and required a sed pass over the
  // built bundle to work at all in a container.
  output: 'standalone',
};

const { withSentryConfig } = require('@sentry/nextjs');

module.exports = withSentryConfig(module.exports, {
  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
  silent: true,
  org: 'vantik',
  project: 'javascript-nextjs',
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Skip release creation/source map upload entirely when no token is
  // configured (e.g. self-hosted docker builds) instead of failing the build
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },

  webpack: {
    // Automatically tree-shake Sentry logger statements to reduce bundle size
    treeshake: {
      removeDebugLogging: true,
    },

    // Enables automatic instrumentation of Vercel Cron Monitors.
    automaticVercelMonitors: true,
  },
});
