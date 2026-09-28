import { defineConfig } from 'astro/config';

// A Cloudflare Worker (apps/landing/wrangler.jsonc) serves the build output at vantik.dev. The documentation is
// apps/docs, at docs.vantik.dev.
export default defineConfig({
  site: 'https://vantik.dev',
  trailingSlash: 'never',
  build: { format: 'file' },
});
