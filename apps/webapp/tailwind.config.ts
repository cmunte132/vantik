import type { Config } from 'tailwindcss';

import ui from '@vantikhq/ui/tailwind.config';

// The ui package's theme, scanning this app's sources and the ui components it
// renders. One pass over both, so the bundle carries one copy of Tailwind's
// base styles rather than one from each package.
export default {
  ...ui,
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
} satisfies Config;
