import { defineConfig } from 'tsup';

// pnpm sets this for the script it runs, so it reaches tsup whatever turbo
// passes through, and it is not an input for turbo to hash.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const isDev = process.env.npm_lifecycle_event === 'dev:main'; // This must match the npm script name

export default defineConfig([
  {
    clean: false,
    tsconfig: 'tsconfig.json',
    dts: true,
    splitting: false,
    entry: ['src/index.ts'],
    format: ['esm'],
    minify: false,
    metafile: false,
    sourcemap: true,
    target: 'esnext',
    outDir: 'dist',
    async onSuccess() {
      if (isDev) {
        console.debug('Running onSuccess() in dev');
        // exec: node dist/index.js
      }
    },
    banner: {
      js: "import { createRequire as createRequireFromMetaUrl } from 'node:module';const require = createRequireFromMetaUrl(import.meta.url);",
    },
  },
  // The Vantik extension for omp, shipped with the CLI. The server's hosted runs
  // load the same source, so one file serves both. It imports nothing at run
  // time but Node and its sibling, which this bundles in.
  {
    clean: false,
    tsconfig: 'tsconfig.json',
    dts: false,
    splitting: false,
    entry: {
      'pi-extension/vantik-extension':
        '../../apps/server/src/modules/agent-runs/pi-extension/vantik-extension.ts',
    },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    minify: false,
    sourcemap: false,
    outDir: 'dist',
  },
]);
