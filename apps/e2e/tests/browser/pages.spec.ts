import type { Page } from '@playwright/test';

import { getPage, unique } from '../../src/api';
import type { Account } from '../../src/auth';
import { expect, test } from '../../src/fixtures';

/** Makes a new page from the pages list, and answers its id. */
async function newPage(page: Page, account: Account): Promise<string> {
  await page.goto(`/${account.workspaceSlug}/pages`);
  await page.getByRole('button', { name: 'New page', exact: true }).click();
  await page.waitForURL(/\/pages\/[^/]+$/);
  return new URL(page.url()).pathname.split('/').pop() as string;
}

test.describe('pages', () => {
  test('a new page saves its title and what is written in it', async ({
    page,
    asAlice,
    alice,
  }) => {
    const title = unique('Written down');
    const text = unique('Every word of this page');

    const id = await newPage(page, alice);
    await page.getByPlaceholder('Untitled page').fill(title);
    await page.locator('.ProseMirror').first().click();
    await page.keyboard.type(text);

    // Saved is shown only once the server has confirmed it.
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await expect
      .poll(async () => await getPage(asAlice, id))
      .toMatchObject({ title, description: expect.stringContaining(text) });
  });

  test('an edit made just before leaving the page is kept', async ({
    page,
    asAlice,
    alice,
  }) => {
    const text = unique('Written a moment before leaving');

    const id = await newPage(page, alice);
    await page.locator('.ProseMirror').first().click();
    await page.keyboard.type(text);
    // Straight to another part of the app, inside the second the page waits
    // before it saves.
    await page.getByRole('link', { name: 'Inbox' }).click();
    await page.waitForURL(/\/inbox$/);

    await expect
      .poll(async () => (await getPage(asAlice, id)).description ?? '')
      .toContain(text);
  });
});
