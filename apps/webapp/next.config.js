/** Copyright (c) 2024, Vantik, all rights reserved. **/

module.exports = {
  reactStrictMode: false,
  transpilePackages: ['geist', '@vantikhq/ui', 'react-day-picker', 'date-fns'],
  experimental: {
    esmExternals: 'loose',
  },
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
