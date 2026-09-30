/** Copyright (c) 2024, Vantik, all rights reserved. **/

import type { Plugin } from 'vite';

import path from 'node:path';

import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import buildStamp from './build-id';
import { DEXIE_SCHEMA_VERSION } from './src/store/schema-version';

// `baseUrl: "src"` in tsconfig.json makes every top-level directory under src a
// bare import specifier (`store/database`, `common/types`). Vite resolves bare
// specifiers as packages, so each one needs an explicit alias here.
const SRC_DIRECTORIES = [
  'common',
  'components',
  'hooks',
  'modules',
  'pages',
  'services',
  'store',
];

const alias = SRC_DIRECTORIES.flatMap((directory) => [
  {
    find: new RegExp(`^${directory}/`),
    // The trailing slash is added back after resolve(), which strips it: the
    // regex above consumes the one in the specifier.
    replacement: `${path.resolve(__dirname, 'src', directory)}/`,
  },
  {
    // A directory with an index file is also imported by its bare name, as in
    // `import { useScope } from 'hooks'`. The rule above needs the slash, so it
    // does not match that form and vite looks for a package called `hooks`.
    find: new RegExp(`^${directory}$`),
    replacement: path.resolve(__dirname, 'src', directory),
  },
]);

// @vantikhq/types from its source, like the ui package. Its dist is a tsup
// build whose declaration pass runs the whole type checker, which is more
// memory than the rest of the image build together, and a bundle needs none of
// it.
alias.push({
  find: /^@vantikhq\/types$/,
  replacement: path.resolve(__dirname, '../../packages/types/src/index.ts'),
});

const { buildId, commit, builtAt } = buildStamp.resolveBuildStamp();

/**
 * What is being served right now, at /api/version.
 *
 * The build writes it as version.json, next to the bundle it describes, and
 * the web server answers /api/version with that file (see nginx.conf). In
 * development this plugin answers it. Either way the answer comes from the
 * same place as the assets, which is the point: a version from any other
 * process could disagree with them, and this is the tie-breaker the other
 * detection paths defer to.
 */
function versionFile(): Plugin {
  const body = JSON.stringify({
    buildId,
    commit,
    builtAt: builtAt ?? '',
    // The local-database schema the serving build expects. A client reads it
    // for information only; the wipe-or-migrate decision is taken client-side
    // against its own bundled value, so the server can never force a reset.
    dexieSchemaVersion: DEXIE_SCHEMA_VERSION,
  });

  return {
    name: 'vantik-version-file',
    configureServer(server) {
      server.middlewares.use('/api/version', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: body });
    },
  };
}

const backend = process.env.BACKEND_URL ?? 'http://localhost:3001';

// Release builds in CI carry a Sentry token. They build source maps, upload
// them, and delete them, so Sentry can read stack traces and browsers never
// get the maps. Every other build skips all three.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

export default defineConfig({
  plugins: [
    react(),
    versionFile(),
    sentryAuthToken &&
      sentryVitePlugin({
        org: 'vantik',
        project: 'javascript-nextjs',
        authToken: sentryAuthToken,
        release: { name: buildId },
        sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
        telemetry: false,
      }),
  ],
  resolve: { alias },
  define: {
    'import.meta.env.VANTIK_BUILD_ID': JSON.stringify(buildId),
    'import.meta.env.VANTIK_BUILD_COMMIT': JSON.stringify(commit),
    'import.meta.env.VANTIK_BUILT_AT': JSON.stringify(builtAt ?? ''),
  },
  server: {
    port: 3000,
    strictPort: true,
    // The same routes nginx.conf proxies in production.
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        // SuperTokens is mounted at /api/auth on the server, so that the
        // refresh-token cookie it sets is scoped to the path the browser asks
        // for. Every other /api path loses its prefix.
        rewrite: (url) =>
          url.startsWith('/api/auth') ? url : url.replace(/^\/api/, ''),
      },
      // `npx skills add https://your-vantik-host` looks for the agent skills
      // index at the origin, not under /api.
      '/.well-known/agent-skills': { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: sentryAuthToken ? 'hidden' : false,
  },
  // Vite 8 transforms with oxc, and it applies no JSX runtime unless it is told
  // to. Without this, an import of any file that holds JSX fails to parse in a
  // test, and a test cannot reach a module that merely sits beside a component.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // The suite covers store models, selectors, hooks and other logic, none of
    // which needs the DOM. A test cannot mount a component, but it can call a
    // hook through store/test-support/render-hook, which renders to a string.
    environment: 'node',
    // IndexedDB for Dexie, which looks for it once, when it is first loaded.
    // Installing it here rather than in the tests that need it means no import
    // has to come first, and an import sorter cannot move it after Dexie.
    setupFiles: ['fake-indexeddb/auto'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    alias,
  },
});
