import type { Page } from '@playwright/test';

import { createSpareTeam, workspacesOf } from '../../src/api';
import type { Account } from '../../src/auth';
import { SIGNED_OUT, signInInBrowser } from '../../src/browser';
import { runTag } from '../../src/env';
import { expect, test } from '../../src/fixtures';
import { messageIdsTo, readEmail } from '../../src/mailpit';

/**
 * Invites `email` to one team from the members settings, the way an admin
 * does, and waits for the invite to be mailed.
 */
async function inviteFromSettings(
  page: Page,
  account: Account,
  email: string,
  teamName: string,
) {
  const alreadySeen = await messageIdsTo(page.request, email);

  await page.goto(`/${account.workspaceSlug}/settings/members`);
  await page.getByRole('button', { name: 'Add member' }).click();

  const dialog = page.getByRole('dialog', { name: /^Add member/ });
  await dialog.getByLabel('Emails').fill(email);
  await dialog.getByPlaceholder('Select teams').click();
  await page.getByRole('option', { name: teamName }).click();
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
  // It closes once the mail has gone.
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  await readEmail(page.request, email, /^Invite to /, alreadySeen);
}

test.describe('an invite', () => {
  test('sent from the members settings is accepted from the invites page', async ({
    page,
    browser,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const { name: workspaceName } = (await workspacesOf(asAlice)).find(
      (workspace) => workspace.id === alice.workspaceId,
    )!;
    const email = `joins+${runTag()}@e2e.vantik.test`;

    await inviteFromSettings(page, alice, email, team.name);

    const invited = await browser.newContext({ storageState: SIGNED_OUT });
    const theirs = await invited.newPage();
    await signInInBrowser(theirs, theirs.request, email);
    await expect(theirs).toHaveURL(/\/invites$/);
    await expect(theirs.getByText(workspaceName)).toBeVisible();

    await theirs.getByRole('button', { name: 'Accept' }).click();
    await expect(theirs).toHaveURL(new RegExp(`/${alice.workspaceSlug}(/|$)`));
    await invited.close();
  });

  test('declined leaves for onboarding, and cannot be taken up after', async ({
    page,
    browser,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const email = `declines+${runTag()}@e2e.vantik.test`;

    await inviteFromSettings(page, alice, email, team.name);

    const invited = await browser.newContext({ storageState: SIGNED_OUT });
    const theirs = await invited.newPage();
    await signInInBrowser(theirs, theirs.request, email);
    await expect(theirs).toHaveURL(/\/invites$/);

    const { invites } = (await (await invited.request.get('/api/v1/users')).json()) as {
      invites: Array<{ id: string }>;
    };
    expect(invites).toHaveLength(1);

    // The page used to stay put after a decline, showing the invite still
    // there. With no workspace and no invite left, onboarding is next.
    await theirs.getByRole('button', { name: 'Decline' }).click();
    await expect(theirs).toHaveURL(/\/onboarding$/);

    // A declined invite used to be as good as an open one.
    const accept = await invited.request.post('/api/v1/workspaces/invite_action', {
      data: { inviteId: invites[0].id, accept: true },
    });
    expect(accept.status()).toBe(404);
    await invited.close();
  });
});
