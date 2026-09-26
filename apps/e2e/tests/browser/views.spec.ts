import { createIssue, createSpareTeam, stateNamed, unique } from '../../src/api';
import { ALICE_BROWSER_STATE, gotoTeamIssues, issueRow } from '../../src/browser';
import { expect, test } from '../../src/fixtures';

test.describe('views', () => {
  test('filters saved as a view come back from the server', async ({
    page,
    browser,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const inTodo = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Shown by the view'),
    });
    const inBacklog = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Left out of the view'),
      stateId: (await stateNamed(asAlice, team.id, 'Backlog')).id,
    });
    const name = unique('Todo only');

    await gotoTeamIssues(page, alice, team);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByRole('option', { name: 'Status', exact: true }).click();
    await page.getByRole('option', { name: 'Todo', exact: true }).click();

    await page.getByRole('button', { name: 'Save as view' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Name of the view').fill(name);
    // Required, six characters at least, though the form doesn't say so.
    await dialog.getByPlaceholder('Description of the view').fill('Issues waiting to be started');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL(/\/views\/[^/]+$/);

    // A browser with nothing cached shows only what the server sends it.
    const fresh = await browser.newContext({ storageState: ALICE_BROWSER_STATE });
    const other = await fresh.newPage();
    await other.goto(page.url());

    await expect(other.getByText(name).first()).toBeVisible();
    await expect(issueRow(other, inTodo.title)).toBeVisible();
    await expect(issueRow(other, inBacklog.title)).toBeHidden();
    await fresh.close();
  });
});
