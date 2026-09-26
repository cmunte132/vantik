import { createIssue, createSpareTeam, getIssue, stateNamed, unique } from '../../src/api';
import { gotoTeamIssues } from '../../src/browser';
import { expect, test } from '../../src/fixtures';

test.describe('board', () => {
  test('a card moved to the next column takes that status', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const inProgress = await stateNamed(asAlice, team.id, 'In Progress');
    const moving = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Moved across the board'),
    });
    // A column with no cards isn't drawn, so the one to the right of Todo is
    // In Progress only when it holds something.
    await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Already started'),
      stateId: inProgress.id,
    });

    await gotoTeamIssues(page, alice, team);
    await page.getByRole('button', { name: 'Kanban view' }).click();

    // The same move a mouse drag makes, from the keyboard: lift, one column
    // right, drop.
    const card = page.locator(`[data-rfd-drag-handle-draggable-id$="__${moving.id}"]`);
    await expect(card).toBeVisible();
    await card.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');

    await expect
      .poll(async () => (await getIssue(asAlice, moving.id)).stateId)
      .toBe(inProgress.id);
  });
});
