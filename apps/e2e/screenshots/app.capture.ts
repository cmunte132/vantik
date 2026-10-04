import { expect, test, type Locator, type Page } from '@playwright/test';

import { SIGNED_OUT, signInInBrowser } from '../src/browser';
import { runTag } from '../src/env';
import { shot } from './frame';
import { DOCS_BROWSER_STATE, loadDocsRun, type DocsRun } from './run';

/**
 * Each test opens one page of the seeded workspace and saves one screenshot
 * under apps/docs/static/img/docs/<name>.png, cropped to what that docs page
 * is about (see frame.ts). To add one, seed what it shows in seed.ts, write a
 * test here, and reference the image from a docs page as /img/docs/<name>.png.
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

/** The page itself, without the sidebar. */
function content(page: Page): Locator {
  return page.locator('.context-box').first();
}

/** One section of a settings page: its heading, description and controls. */
function section(page: Page, title: string): Locator {
  return page
    .getByRole('heading', { level: 3, name: title, exact: true })
    .locator('xpath=../..');
}

/** Picks one of the layouts in the top bar of an issue list. */
async function layout(page: Page, name: 'Kanban' | 'Spreadsheet') {
  await page.getByRole('button', { name: `${name} view` }).click();
}

async function allIssues(page: Page) {
  await page.goto(`${team}/all`);
  await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
}

async function featuredIssue(page: Page) {
  await page.goto(`${workspace}/issue/${run.owner.teamIdentifier}-1`);
  await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
}

test.describe('getting started', () => {
  test('sign-in page', async ({ browser }) => {
    const context = await browser.newContext({ storageState: SIGNED_OUT });
    const page = await context.newPage();
    await page.clock.setFixedTime(run.clockAt);
    await page.goto('/auth');
    await page.getByPlaceholder('Email address').fill('ada@acme.dev');
    await shot(page, 'getting-started/sign-in', {
      focus: [
        page.getByText('Welcome', { exact: true }),
        page.getByText(/By clicking continue/),
      ],
      padding: 48,
    });
    await context.close();
  });

  test('onboarding', async ({ browser, request }) => {
    const context = await browser.newContext({ storageState: SIGNED_OUT });
    const page = await context.newPage();
    await page.clock.setFixedTime(run.clockAt);
    await signInInBrowser(page, request, `ada+${runTag()}@docs.vantik.test`);
    await expect(page).toHaveURL(/\/onboarding/);
    await shot(page, 'getting-started/onboarding', {
      focus: [
        page.getByText('Welcome to Vantik'),
        page.getByRole('button', { name: 'Continue' }),
      ],
      padding: 48,
    });
    await context.close();
  });
});

test.describe('issues', () => {
  test('list', async ({ page }) => {
    await allIssues(page);
    await shot(page, 'issues/list', { focus: content(page), padding: 0 });
  });

  test('board', async ({ page }) => {
    await allIssues(page);
    await layout(page, 'Kanban');
    await shot(page, 'issues/board', { focus: content(page), padding: 0 });
  });

  test('spreadsheet', async ({ page }) => {
    await allIssues(page);
    await layout(page, 'Spreadsheet');
    await shot(page, 'issues/spreadsheet', { focus: content(page), padding: 0 });
  });

  test('display options', async ({ page }) => {
    await allIssues(page);
    // Images before 2026.10.2 have no name on the button: it is the one after
    // the layout switch.
    const trigger = page
      .getByRole('button', { name: 'Display options' })
      .or(
        page
          .getByRole('button', { name: 'Spreadsheet view' })
          .locator('xpath=following::button[1]'),
      )
      .first();
    await trigger.click();
    await shot(page, 'issues/display-options', {
      focus: [trigger, page.getByRole('dialog')],
      highlight: trigger,
    });
  });

  test('filter', async ({ page }) => {
    await allIssues(page);
    const trigger = page.getByRole('button', { name: 'Filter', exact: true });
    await trigger.click();
    const input = page.getByPlaceholder('Type for filters...');
    await input.click();
    const options = page.getByRole('listbox');
    await expect(options).toBeVisible();
    await shot(page, 'issues/filter', { focus: [input, options] });
  });

  test('group by', async ({ page }) => {
    await allIssues(page);
    // An open Select hides the rest of the page from the accessibility tree,
    // so find the trigger by its attribute, not by its role.
    const trigger = page
      .locator('[role="combobox"]')
      .filter({ hasText: 'Status' })
      .first();
    await trigger.click();
    await shot(page, 'issues/group-by', {
      focus: [trigger, page.getByRole('listbox')],
      highlight: trigger,
    });
  });

  test('triage group', async ({ page }) => {
    await allIssues(page);
    const header = page.getByText('Triage', { exact: true }).first();
    await expect(page.getByText('Apple Pay at checkout')).toBeVisible();
    await shot(page, 'triage/triage-group', {
      focus: [
        header,
        // The whole row, so the labels and the assignee at the right show too.
        page
          .getByText('Customer reports a blank page after paying')
          .locator('xpath=ancestor::a[1]'),
      ],
      padding: 8,
    });
  });

  test('issue page', async ({ page }) => {
    await featuredIssue(page);
    await shot(page, 'issues/issue', { focus: content(page), padding: 0 });
  });

  test('definition of done', async ({ page }) => {
    await featuredIssue(page);
    await shot(page, 'issues/definition-of-done', {
      focus: [
        page.getByText('Definition of Done', { exact: true }).first(),
        page.getByText('The merge is covered by an end-to-end test'),
      ],
    });
  });

  test('sub-issues', async ({ page }) => {
    await featuredIssue(page);
    // Each list is a collapsible that is closed until clicked.
    const list = (name: string) =>
      page
        .getByRole('button', { name, exact: true })
        .locator('xpath=ancestor::div[@data-state][contains(@class, "w-full")][1]');
    await page.getByRole('button', { name: 'Sub-issues', exact: true }).click();
    await page.getByRole('button', { name: 'Relations', exact: true }).click();
    await expect(
      page.getByText('Retry a declined card payment once').first(),
    ).toBeVisible();
    await shot(page, 'issues/sub-issues', {
      focus: [list('Sub-issues'), list('Relations')],
      padding: 8,
    });
  });

  test('delegate', async ({ page }) => {
    await featuredIssue(page);
    const trigger = page.getByRole('button', { name: 'Delegate to an agent' });
    await trigger.click();
    await shot(page, 'agents/delegate', {
      focus: [trigger, page.getByRole('dialog')],
      highlight: trigger,
    });
  });

  test('my issues', async ({ page }) => {
    await page.goto(`${workspace}/my-issues`);
    await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
    await shot(page, 'issues/my-issues', { focus: content(page), padding: 0 });
  });

  test('inbox', async ({ page }) => {
    await page.goto(`${workspace}/inbox`);
    await page.getByText('Keep the cart when').first().click();
    await expect(page.getByRole('heading', { level: 2, name: run.seeded.featuredIssueTitle })).toBeVisible();
    await shot(page, 'issues/inbox', { focus: content(page), padding: 0 });
  });
});

test.describe('views', () => {
  test('list', async ({ page }) => {
    await page.goto(`${team}/views`);
    await expect(page.getByText('Urgent bugs')).toBeVisible();
    await shot(page, 'views/views', { focus: content(page), padding: 0 });
  });

  test('save view', async ({ page }) => {
    await allIssues(page);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByPlaceholder('Type for filters...').click();
    await page.getByRole('option', { name: 'Status', exact: true }).click();
    await page.getByRole('option', { name: 'Triage', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save as view' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Name of the view').fill('New bugs');
    // The dialog role is on the full-screen layer, so frame its contents.
    await shot(page, 'views/save-view', {
      focus: [
        dialog.getByText('Save view', { exact: true }),
        dialog.getByRole('button', { name: 'Save', exact: true }),
        dialog.getByPlaceholder('Description of the view'),
      ],
      padding: 24,
    });
  });

  test('view', async ({ page }) => {
    await page.goto(`${team}/views/${run.seeded.viewId}`);
    await expect(page.getByText('Payment provider webhooks arrive twice')).toBeVisible();
    await shot(page, 'views/view', { focus: content(page), padding: 0 });
  });
});

test.describe('projects', () => {
  test('list', async ({ page }) => {
    await page.goto(`${workspace}/projects`);
    await expect(page.getByText('New checkout').first()).toBeVisible();
    await shot(page, 'projects/projects', { focus: content(page), padding: 0 });
  });

  test('project', async ({ page }) => {
    await page.goto(`${workspace}/projects/${run.seeded.projectId}`);
    await expect(page.getByText('New checkout').first()).toBeVisible();
    await shot(page, 'projects/project', { focus: content(page), padding: 0 });
  });
});

test('cycle', async ({ page }) => {
  await page.goto(`${team}/cycles/${run.seeded.cycleNumber}`);
  await page.getByRole('button', { name: 'Issues', exact: true }).click();
  await expect(page.getByText(run.seeded.featuredIssueTitle).first()).toBeVisible();
  await shot(page, 'cycles/cycle', { focus: content(page), padding: 0 });
});

test.describe('product axis', () => {
  test('product', async ({ page }) => {
    await page.goto(`${workspace}/product/${run.seeded.productKey}`);
    await expect(page.getByText('Storefront').first()).toBeVisible();
    await shot(page, 'product-axis/product', { focus: content(page), padding: 0 });
  });

  test('module', async ({ page }) => {
    await page.goto(`${workspace}/module/${run.seeded.moduleKey}`);
    await expect(page.getByText('Web app').first()).toBeVisible();
    await shot(page, 'product-axis/module', { focus: content(page), padding: 0 });
  });

  test('capability', async ({ page }) => {
    await page.goto(`${workspace}/capability/${run.seeded.capabilityId}`);
    await expect(page.getByText('Checkout').first()).toBeVisible();
    await shot(page, 'product-axis/capability', { focus: content(page), padding: 0 });
  });
});

test('knowledge page', async ({ page }) => {
  await page.goto(`${workspace}/pages/${run.seeded.pageId}`);
  await expect(page.getByText('Payments').first()).toBeVisible();
  await shot(page, 'knowledge/page', { focus: content(page), padding: 0 });
});

test.describe('agent runs', () => {
  const runPage = async (page: Page, id: string, title: string) => {
    await page.goto(`${workspace}/agent-runs/${id}`);
    await expect(page.getByText(title).first()).toBeVisible();
  };

  test('list', async ({ page }) => {
    await page.goto(`${workspace}/agent-runs`);
    await expect(
      page.getByText('Payment provider webhooks arrive twice').first(),
    ).toBeVisible();
    await shot(page, 'agents/runs', { focus: content(page), padding: 0 });
  });

  test('running', async ({ page }) => {
    await runPage(
      page,
      run.seeded.agents.runningRunId,
      'Payment provider webhooks arrive twice',
    );
    await shot(page, 'agents/run-running', { focus: content(page), padding: 0 });
  });

  test('handback', async ({ page }) => {
    await runPage(
      page,
      run.seeded.agents.succeededRunId,
      'Address form loses focus on autofill',
    );
    await shot(page, 'agents/run-handback', { focus: content(page), padding: 0 });
  });

  test('rejected', async ({ page }) => {
    await runPage(
      page,
      run.seeded.agents.rejectedRunId,
      'Document the checkout events for analytics',
    );
    await shot(page, 'agents/run-rejected', { focus: content(page), padding: 0 });
  });

  test('failed', async ({ page }) => {
    await runPage(
      page,
      run.seeded.agents.failedRunId,
      'Show stock levels on the product page',
    );
    await shot(page, 'agents/run-failed', { focus: content(page), padding: 0 });
  });

  // The run handed to a person, so the dialog is the Reject one. A failed
  // hosted run pushed nothing, so it never offers Clean up.
  test('clean up', async ({ page }) => {
    await runPage(
      page,
      run.seeded.agents.handedOverRunId,
      'Show stock levels on the product page',
    );
    await page.getByRole('button', { name: 'Reject' }).first().click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
    await expect(dialog).toBeVisible();
    await shot(page, 'agents/clean-up', { focus: dialog });
  });
});

test.describe('settings', () => {
  // [image, settings path under the workspace, section heading]
  const sections: Array<[string, string, string]> = [
    ['settings/access-tokens', 'settings/account/api', 'Access tokens'],
    ['settings/connect-client', 'settings/account/api', 'Connecting a client'],
    ['settings/model-access', 'settings/agents', 'Model access'],
    ['settings/agent-accounts', 'settings/agents', 'Agent accounts'],
    ['settings/members', 'settings/members', 'Members'],
    ['settings/labels', 'settings/labels', 'Workspace labels'],
    ['settings/workflow', 'settings/teams/ENG/workflow', 'Workflow'],
    ['settings/cycles', 'settings/teams/ENG/cycles', 'Cycles'],
    ['settings/templates', 'settings/teams/ENG/templates', 'Templates'],
    ['settings/notifications', 'settings/account/notifications', 'Notifications'],
    ['settings/integrations', 'settings/integrations', 'Integrations'],
  ];

  for (const [name, path, title] of sections) {
    test(name, async ({ page }) => {
      await page.goto(`${workspace}/${path}`);
      const found = section(page, title);
      await expect(found).toBeVisible();
      await shot(page, name, { focus: found });
    });
  }
});

test.describe('concepts', () => {
  test('workspace menu', async ({ page }) => {
    await allIssues(page);
    // The trigger names the workspace and counts its members.
    const trigger = page
      .locator('[data-sidebar="rail-item"]')
      .filter({ hasText: /members?$/ });
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Workspace settings' })).toBeVisible();
    await shot(page, 'concepts/workspace-menu', {
      focus: [trigger, page.getByRole('menu')],
      highlight: trigger,
    });
  });

  test('teams', async ({ page }) => {
    await allIssues(page);
    // The label row and the team rows below it are one sidebar group.
    const group = page.getByText('Your teams', { exact: true }).locator('..');
    await expect(group.getByText('Design', { exact: true })).toBeVisible();
    await shot(page, 'concepts/teams', { focus: group, padding: 8 });
  });
});

test.describe('everyday', () => {
  test('command palette', async ({ page }) => {
    await allIssues(page);
    await page.keyboard.press('Meta+k');
    // The dialog is the whole blurred screen; the palette is its input and list.
    const input = page.getByPlaceholder('Search command...');
    await expect(input).toBeVisible();
    await shot(page, 'everyday/command-palette', {
      focus: [input, page.getByRole('listbox')],
    });
  });

  test('search', async ({ browser }) => {
    // The search box debounces with Date.now, which a fixed clock never moves,
    // so this page keeps the real clock.
    const context = await browser.newContext({ storageState: DOCS_BROWSER_STATE });
    const page = await context.newPage();
    await allIssues(page);
    await page.keyboard.press('Meta+/');
    const input = page.getByPlaceholder('Type a command or search...');
    await expect(input).toBeVisible();
    await input.fill('checkout');
    // Issues arrive after the debounce; until then the list reads "No results".
    await expect(
      page
        .getByRole('option')
        .filter({ hasText: run.seeded.featuredIssueTitle })
        .first(),
    ).toBeVisible();
    await shot(page, 'everyday/search', {
      focus: [input, page.getByRole('listbox')],
    });
    await context.close();
  });

  test('template picker', async ({ page }) => {
    await allIssues(page);
    await page.keyboard.press('c');
    // An open menu hides the rest of the page from the accessibility tree, so
    // find the trigger by its text, not by its role.
    const trigger = page.locator('button', { hasText: /^Template$/ });
    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu.getByText('Bug report')).toBeVisible();
    await shot(page, 'everyday/template-picker', {
      focus: [trigger, menu, page.getByText('Issue title', { exact: true })],
      highlight: trigger,
    });
  });
});
