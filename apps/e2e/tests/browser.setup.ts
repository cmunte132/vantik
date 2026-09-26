import { expect, test as setup } from '@playwright/test';

import { ALICE_BROWSER_STATE, signInInBrowser } from '../src/browser';
import { loadAccounts } from '../src/fixtures';

/**
 * Alice signs in to the webapp through its sign-in page, with the code from
 * the email, and the browser tests start from the session that leaves: cookies
 * set by the webapp's proxy, not the header session the API tests use.
 */
setup('Alice signs in to the webapp', async ({ page, request }) => {
  const { alice } = loadAccounts();

  await signInInBrowser(page, request, alice.email);
  await expect(page).toHaveURL(new RegExp(`/${alice.workspaceSlug}(/|$)`));

  await page.context().storageState({ path: ALICE_BROWSER_STATE });
});
