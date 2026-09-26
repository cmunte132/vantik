import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

import type { Account } from './auth';
import { messageIdsTo, readLoginEmail } from './mailpit';

/**
 * Helpers for the browser project, which drives the webapp as Alice. Her
 * browser session is a cookie session of its own, made by signing in through
 * the sign-in page; the API fixtures keep using her access token.
 */

/** Where the browser setup leaves Alice's signed-in browser state. */
export const ALICE_BROWSER_STATE = `${__dirname}/../.auth/alice.browser.json`;

/** A browser context with nobody signed in. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/**
 * Signs `email` in through the sign-in page: asks for a code, reads it from
 * the email, types it in. A new address gets an account the same way.
 */
export async function signInInBrowser(
  page: Page,
  request: APIRequestContext,
  email: string,
) {
  await page.goto('/auth');
  const alreadySeen = await messageIdsTo(request, email);

  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Send a magic link' }).click();
  await expect(
    page.getByRole('heading', { name: 'Check your email' }),
  ).toBeVisible();

  const { code } = await readLoginEmail(request, email, alreadySeen);
  await page.getByPlaceholder('Enter login code').fill(code);
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page).not.toHaveURL(/\/auth/);
}

/** Opens the list of every issue in a team of `account`'s workspace. */
export async function gotoTeamIssues(
  page: Page,
  account: Account,
  team: { identifier: string },
) {
  await page.goto(`/${account.workspaceSlug}/team/${team.identifier}/all`);
  await expect(page.getByRole('grid')).toBeVisible();
}

/**
 * The row, or board card, that shows the issue with this title. A row is an
 * anchor with no href, which gives it no role to find it by.
 */
export function issueRow(page: Page, title: string): Locator {
  return page.locator('a').filter({ hasText: title });
}

/** Opens an issue from the list into the side sheet. */
export async function openIssue(page: Page, title: string) {
  await issueRow(page, title).getByText(title, { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close issue' })).toBeVisible();
}

/**
 * The control of one of the properties down the side of an open issue. The
 * name is matched exactly: Project would otherwise find Project Milestone too.
 */
export function propertyControl(page: Page, property: string): Locator {
  return page
    .getByRole('group', { name: property, exact: true })
    .getByRole('combobox');
}

/**
 * Picks `option` from one of the properties down the side of an open issue,
 * like Status or Labels, by typing it and pressing Enter.
 */
export async function setProperty(
  page: Page,
  property: string,
  option: string,
) {
  await propertyControl(page, property).click();
  await page.keyboard.type(option);
  await page.keyboard.press('Enter');
}
