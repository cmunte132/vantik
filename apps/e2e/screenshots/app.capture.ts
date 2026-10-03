import { expect, test, type Page } from '@playwright/test';

import { SIGNED_OUT, signInInBrowser } from '../src/browser';
import { runTag } from '../src/env';
import { loadDocsRun, type DocsRun } from './run';

/**
 * Each test opens one page of the seeded workspace and saves one screenshot
 * under apps/docs/static/img/docs/<name>.png. To add one, write a test here
 * and reference the image from a docs page as /img/docs/<name>.png.
 */

// Read once the setup project has written it, not when this file loads.
let run: DocsRun;
let workspace: string;
let team: string;

test.beforeAll(() => {
  run = loadDocsRun();
  workspace = `/${run.owner.workspaceSlug}`;
  team = `${workspace}/team/${run.owner.teamIdentifier}`;
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(run.clockAt);
});

/**
 * Saves the viewport as `<name>.png` once the page has settled. Each run signs
 * up with new addresses, because addresses are unique on the server, so they
 * are shown as fixed ones: `ada+k3x9@docs.vantik.test` becomes `ada@acme.dev`.
 */
async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const perRun = /([a-z]+)\+[a-z0-9]+@docs\.vantik\.test/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      node.textContent = node.textContent!.replace(perRun, '$1@acme.dev');
    }
    for (const input of document.querySelectorAll('input')) {
      input.value = input.value.replace(perRun, '$1@acme.dev');
    }
  });
  await expect(page).toHaveScreenshot(`${name}.png`.split('/'));
}

/** Picks one of the layouts in the top bar of an issue list. */
async function layout(page: Page, name: 'Kanban' | 'Spreadsheet') {
  await page.getByRole('button', { name: `${name} view` }).click();
}

test.describe('getting started', () => {
  test('sign-in page', async ({ browser }) => {
    const context = await browser.newContext({ storageState: SIGNED_OUT });
    const page = await context.newPage();
    await page.clock.setFixedTime(run.clockAt);
    await page.goto('/auth');
    await page.getByPlaceholder('Email address').fill('ada@acme.dev');
    await shot(page, 'getting-started/sign-in');
    await context.close();
  });

  test('onboarding', async ({ browser, request }) => {
    const context = await browser.newContext({ storageState: SIGNED_OUT });
    const page = await context.newPage();
    await page.clock.setFixedTime(run.clockAt);
    await signInInBrowser(page, request, `ada+${runTag()}@docs.vantik.test`);
    await expect(page).toHaveURL(/\/onboarding/);
    await shot(page, 'getting-started/onboarding');
    await context.close();
  });
});

test.describe('issues', () => {
  test('list', async ({ page }) => {
    await page.goto(`${team}/all`);
    await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
    await shot(page, 'issues/list');
  });

  test('board', async ({ page }) => {
    await page.goto(`${team}/all`);
    await layout(page, 'Kanban');
    await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
    await shot(page, 'issues/board');
  });

  test('spreadsheet', async ({ page }) => {
    await page.goto(`${team}/all`);
    await layout(page, 'Spreadsheet');
    await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
    await shot(page, 'issues/spreadsheet');
  });

  test('issue page', async ({ page }) => {
    await page.goto(`${workspace}/issue/${run.owner.teamIdentifier}-1`);
    await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
    await shot(page, 'issues/issue');
  });

  test('my issues', async ({ page }) => {
    await page.goto(`${workspace}/my-issues`);
    await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
    await shot(page, 'issues/my-issues');
  });
});

test.describe('views', () => {
  test('list', async ({ page }) => {
    await page.goto(`${team}/views`);
    await expect(page.getByText('Urgent bugs')).toBeVisible();
    await shot(page, 'views/views');
  });

  test('view', async ({ page }) => {
    await page.goto(`${team}/views/${run.seeded.viewId}`);
    await expect(page.getByText('Payment provider webhooks arrive twice')).toBeVisible();
    await shot(page, 'views/view');
  });
});

test.describe('projects', () => {
  test('list', async ({ page }) => {
    await page.goto(`${workspace}/projects`);
    await expect(page.getByText('New checkout').first()).toBeVisible();
    await shot(page, 'projects/projects');
  });

  test('project', async ({ page }) => {
    await page.goto(`${workspace}/projects/${run.seeded.projectId}`);
    await expect(page.getByText('New checkout').first()).toBeVisible();
    await shot(page, 'projects/project');
  });
});

test('cycle', async ({ page }) => {
  await page.goto(`${team}/cycles/${run.seeded.cycleNumber}`);
  await page.getByRole('button', { name: 'Issues', exact: true }).click();
  await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
  await shot(page, 'cycles/cycle');
});

test.describe('product axis', () => {
  test('product', async ({ page }) => {
    await page.goto(`${workspace}/product/${run.seeded.productKey}`);
    await expect(page.getByText('Storefront').first()).toBeVisible();
    await shot(page, 'product-axis/product');
  });

  test('module', async ({ page }) => {
    await page.goto(`${workspace}/module/${run.seeded.moduleKey}`);
    await expect(page.getByText('Web app').first()).toBeVisible();
    await shot(page, 'product-axis/module');
  });

  test('capability', async ({ page }) => {
    await page.goto(`${workspace}/capability/${run.seeded.capabilityId}`);
    await expect(page.getByText('Checkout').first()).toBeVisible();
    await shot(page, 'product-axis/capability');
  });
});

test('knowledge page', async ({ page }) => {
  await page.goto(`${workspace}/pages/${run.seeded.pageId}`);
  await expect(page.getByText('Payments').first()).toBeVisible();
  await shot(page, 'knowledge/page');
});
