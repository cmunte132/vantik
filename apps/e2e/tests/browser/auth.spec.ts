import { expect, test } from '@playwright/test';

import { SIGNED_OUT } from '../../src/browser';
import { loadAccounts } from '../../src/fixtures';
import { messageIdsTo, readLoginEmail } from '../../src/mailpit';

test.use({ storageState: SIGNED_OUT });

test('a mistyped login code can be corrected without another email', async ({ page, request }) => {
  const { alice } = loadAccounts();
  const seen = await messageIdsTo(request, alice.email);
  await page.goto('/auth');
  await page.getByPlaceholder('Email address').fill(alice.email);
  await page.getByRole('button', { name: 'Send a magic link' }).click();
  const { code } = await readLoginEmail(request, alice.email, seen);

  await page.getByPlaceholder('Enter login code').fill(`${code}x`);
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByText('Incorrect code', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await page.getByPlaceholder('Enter login code').fill(code);
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page).toHaveURL(new RegExp(`/${alice.workspaceSlug}(/|$)`));
});
