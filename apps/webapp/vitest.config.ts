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

const alias = SRC_DIRECTORIES.map((directory) => ({
  find: new RegExp(`^${directory}/`),
  // The trailing slash is added back after resolve(), which strips it: the
  // regex above consumes the one in the specifier.
  replacement: `${path.resolve(__dirname, 'src', directory)}/`,
}));

export default defineConfig({
  test: {
    // The suite covers store models, selectors and other pure logic, none of
    // which touches the DOM. Rendering tests would need their own environment.
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    alias,
  },
});
