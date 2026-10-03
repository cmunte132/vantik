import { defineConfig, devices } from '@playwright/test';

import { WEBAPP_URL } from './src/env';
import { DOCS_BROWSER_STATE } from './screenshots/run';

/**
 * Captures the screenshots the docs site shows, from a workspace the setup
 * seeds through the API. It is a separate config so `pnpm e2e` never runs it.
 *
 *   pnpm --filter @vantikhq/e2e screenshots         write every screenshot
 *   pnpm --filter @vantikhq/e2e screenshots:check   compare with what is committed
 *
 * The screenshots are Playwright snapshots stored straight in the docs site's
 * static folder, so the check run fails on a screenshot whose UI has changed
 * and the write run refreshes it.
 */
export default defineConfig({
  testDir: './screenshots',
  snapshotPathTemplate: '../docs/static/img/docs/{arg}{ext}',
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'screenshots-report' }]],
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
      // Text antialiasing differs by a few pixels between runs on the same
      // machine. Anything larger is a change in the UI.
      maxDiffPixelRatio: 0.002,
    },
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: WEBAPP_URL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'docs-setup',
      testMatch: /docs\.setup\.ts/,
    },
    {
      name: 'docs',
      testMatch: /\.capture\.ts/,
      dependencies: ['docs-setup'],
      use: { storageState: DOCS_BROWSER_STATE },
    },
  ],
});
