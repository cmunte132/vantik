import { defineConfig } from 'tsup';

// One ESM file for node. Gondolin stays external: it ships its own guest
// assets and native runners, which a bundle would lose. The shared types are
// bundled, because only their type-free constants reach the output.
export default defineConfig({
  entry: ['./src/main.ts'],
  outDir: './dist',
  platform: 'node',
  target: 'node24',
  format: ['esm'],
  sourcemap: true,
  clean: true,
  bundle: true,
  splitting: false,
  dts: false,
  external: ['@earendil-works/gondolin'],
  noExternal: ['@vantikhq/types'],
});
