import path from 'node:path';

import { defineConfig } from 'vitest/config';

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

export default defineConfig({
  // Vite 8 transforms with oxc, and it applies no JSX runtime unless it is told
  // to. Without this, an import of any file that holds JSX fails to parse, and
  // a test cannot reach a module that merely sits beside a component. Setting
  // it does not render anything: `environment` below is still node.
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
