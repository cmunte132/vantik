import { defineConfig } from 'astro/config';

// Cloudflare Pages serves the build output at vantik.dev. The documentation is
// apps/docs, at docs.vantik.dev.
export default defineConfig({
  site: 'https://vantik.dev',
  trailingSlash: 'never',
  build: { format: 'file' },
});
