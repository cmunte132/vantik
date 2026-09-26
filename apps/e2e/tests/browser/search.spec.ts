import { createIssue, createSpareTeam, searchIssueIds } from '../../src/api';
import { gotoTeamIssues } from '../../src/browser';
import { expect, test } from '../../src/fixtures';

test.describe('search', () => {
  test('finds an issue by a word in its title, and opens it', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const word = `needle${Date.now().toString(36)}`;
    const issue = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: `Look for the ${word}`,
    });

    // The index is written after the issue is, and the box searches once per
    // query, so wait until the server can find it.
    await expect
      .poll(() => searchIssueIds(asAlice, alice, word), { timeout: 20_000 })
      .toContain(issue.id);

    await gotoTeamIssues(page, alice, team);
    await page.getByRole('button', { name: /^Search/ }).click();
    await page.getByPlaceholder('Type a command or search...').fill(word);
    await page.getByRole('option', { name: new RegExp(word) }).click();

    await page.waitForURL(new RegExp(`/issue/${team.identifier}-${issue.number}$`));
    await expect(page.getByText(issue.title).first()).toBeVisible();
  });
});
