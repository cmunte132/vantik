import { defineConfig, devices } from '@playwright/test';

import { ALICE_BROWSER_STATE } from './src/browser';
import { SERVER_URL, WEBAPP_URL } from './src/env';

/**
 * One runner for every layer of end-to-end test, so they share the stack, the
 * accounts and the report:
 *
 *   setup          waits for the stack and provisions the accounts the others use
 *   api            drives the HTTP API (and the MCP endpoint) directly
 *   browser-setup  signs Alice in to the webapp, the way a person does
 *   browser        drives the webapp as Alice, and checks the server with the API
 */
export default defineConfig({
  testDir: './tests',
  // A test that passes only on retry is a finding, not a pass, so nothing is
  // retried locally. CI retries once so a flake shows up as "flaky" in the
  // report instead of failing the build outright, and records a trace of the
  // failed attempt.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'on-failure' }]],
  timeout: 60_000,
  use: {
    baseURL: SERVER_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.ts/,
    },
    {
      name: 'api',
      testDir: './tests/api',
      dependencies: ['setup'],
      fullyParallel: true,
    },
    {
      name: 'browser-setup',
      testMatch: /browser\.setup\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], baseURL: WEBAPP_URL },
    },
    {
      name: 'browser',
      testDir: './tests/browser',
      dependencies: ['browser-setup'],
      // One page at a time. Each test works in a team of its own, so they
      // could share a workspace in parallel, but the editors save half a
      // second after the last keystroke and a starved page misses that.
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        // Wide enough that the issue sheet sits beside the list, as it does
        // on a laptop, rather than over it.
        viewport: { width: 1440, height: 900 },
        baseURL: WEBAPP_URL,
        storageState: ALICE_BROWSER_STATE,
        screenshot: 'only-on-failure',
      },
    },
  ],
});
