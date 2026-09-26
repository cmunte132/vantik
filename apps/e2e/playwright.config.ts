import { defineConfig } from '@playwright/test';

import { SERVER_URL } from './src/env';

/**
 * One runner for every layer of end-to-end test, so they share the stack, the
 * accounts and the report:
 *
 *   setup  waits for the stack and provisions the accounts the others use
 *   api    drives the HTTP API (and the MCP endpoint) directly
 *
 * A browser project will sit beside `api`, depending on `setup` the same way
 * and signing in from the same accounts.
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
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'api',
      testDir: './tests/api',
      dependencies: ['setup'],
      fullyParallel: true,
    },
  ],
});
