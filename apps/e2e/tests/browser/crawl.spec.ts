import type { Page } from '@playwright/test';

import { expect, test } from '../../src/fixtures';

/**
 * Every main page of the webapp, opened with nothing cached, the way a person
 * arriving from a link does. A page passes when it draws without a page error,
 * a console error or a failed request. This is what catches a page that a
 * removed module, a renamed route or a bad response has quietly broken.
 */

const WORKSPACE_PAGES = [
  'inbox',
  'my-issues',
  'all',
  'teams',
  'views',
  'projects',
  'pages',
  'pages/review',
  'products',
  'modules',
  'capabilities',
  'agent-runs',
  'settings/overview',
  'settings/labels',
  'settings/members',
  'settings/agents',
  'settings/new_team',
  'settings/new_product',
  'settings/export',
  'settings/integrations',
  'settings/account/profile',
  'settings/account/preferences',
  'settings/account/security',
  'settings/account/api',
];

const TEAM_PAGES = ['all', 'cycles', 'views'];

const TEAM_SETTINGS = [
  'overview',
  'workflow',
  'cycles',
  'labels',
  'members',
  'templates',
];

/** Everything that went wrong on the page while `during` ran. */
async function problemsWhile(page: Page, during: () => Promise<void>) {
  const problems: string[] = [];

  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console error: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) =>
    problems.push(
      `request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`,
    ),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) {
      problems.push(
        `${response.status()}: ${response.request().method()} ${response.url()}`,
      );
    }
  });

  await during();
  return problems;
}

/**
 * Opens the page and waits for it to settle. The socket stays open, so the
 * network is never idle; instead the page has to have drawn its main content
 * and then gone a moment without a new request.
 */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main, [role="main"]').first()).toBeVisible();
  await page.waitForLoadState('load');
  await page.waitForTimeout(1_500);
}

test.describe('every page draws without an error', () => {
  for (const path of WORKSPACE_PAGES) {
    test(`/${path}`, async ({ page, alice }) => {
      const problems = await problemsWhile(page, () =>
        open(page, `/${alice.workspaceSlug}/${path}`),
      );
      expect(problems).toEqual([]);
    });
  }

  for (const path of TEAM_PAGES) {
    test(`/team/:team/${path}`, async ({ page, alice }) => {
      const problems = await problemsWhile(page, () =>
        open(page, `/${alice.workspaceSlug}/team/${alice.teamIdentifier}/${path}`),
      );
      expect(problems).toEqual([]);
    });
  }

  for (const section of TEAM_SETTINGS) {
    test(`/settings/teams/:team/${section}`, async ({ page, alice }) => {
      const problems = await problemsWhile(page, () =>
        open(
          page,
          `/${alice.workspaceSlug}/settings/teams/${alice.teamIdentifier}/${section}`,
        ),
      );
      expect(problems).toEqual([]);
    });
  }
});
