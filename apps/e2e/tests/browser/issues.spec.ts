import {
  commentsOn,
  createComment,
  createIssue,
  createSpareTeam,
  getIssue,
  issuesOf,
  labelsOf,
  stateNamed,
  unique,
  updateIssue,
} from '../../src/api';
import {
  gotoTeamIssues,
  issueRow,
  openIssue,
  propertyControl,
  setProperty,
} from '../../src/browser';
import { expect, test } from '../../src/fixtures';
import { cursor, synced } from '../../src/sync';

// Each test files its issues into a team of its own, so the list it opens
// holds only what it made, whatever the API tests file meanwhile.

test.describe('issues', () => {
  test('c opens a new issue, which Cmd+Enter creates', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const title = unique('Made from the keyboard');
    const description = unique('Every word of this description');

    await gotoTeamIssues(page, alice, team);
    await page.keyboard.press('c');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // No LLM is configured on the stack, so the title is where typing starts.
    await page.keyboard.type(title);
    await dialog.locator('.ProseMirror').click();
    await page.keyboard.type(description);
    // At once: the description reaches the form half a second late, and a
    // submit inside that half second used to send what it held before.
    await page.keyboard.press('ControlOrMeta+Enter');

    await expect(dialog).toBeHidden();
    await expect(issueRow(page, title)).toBeVisible();

    await expect
      .poll(async () =>
        (await issuesOf(asAlice)).find((issue) => issue.title === title),
      )
      .toMatchObject({
        teamId: team.id,
        description: expect.stringContaining(description),
      });
  });

  test('the side sheet changes status, priority and labels', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const inProgress = await stateNamed(asAlice, team.id, 'In Progress');
    const bug = (await labelsOf(asAlice, alice)).find(
      (label) => label.name === 'Bug',
    );
    expect(bug, 'onboarding seeds a Bug label').toBeTruthy();
    const issue = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Triaged in the sheet'),
    });

    await gotoTeamIssues(page, alice, team);
    await openIssue(page, issue.title);

    await setProperty(page, 'Status', 'In Progress');
    await expect(propertyControl(page, 'Status')).toHaveText('In Progress');

    await setProperty(page, 'Priority', 'P0');
    await expect(propertyControl(page, 'Priority')).toHaveText(/P0/);

    // The title and the description once shared a key, and each change to the
    // issue drew another copy of the title above the last.
    await expect(page.getByRole('textbox', { name: 'Issue title' })).toHaveCount(
      1,
    );

    // Enter on a label used to do nothing; only a click on its checkbox did.
    await setProperty(page, 'Labels', 'Bug');
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('group', { name: 'Labels', exact: true }),
    ).toContainText('Bug');

    await expect
      .poll(async () => {
        const saved = await getIssue(asAlice, issue.id);
        return {
          stateId: saved.stateId,
          priority: saved.priority,
          labelIds: saved.labelIds,
        };
      })
      .toEqual({ stateId: inProgress.id, priority: 1, labelIds: [bug!.id] });
  });

  // The comment is sent the moment it is typed. The editor reports what it
  // holds half a second late, and a comment sent inside that half second was
  // cleared from the box without ever being posted.
  for (const how of ['the send button', 'Cmd+Enter'] as const) {
    test(`a comment sent at once with ${how} is posted`, async ({
      page,
      asAlice,
      alice,
    }) => {
      const team = await createSpareTeam(asAlice);
      const issue = await createIssue(asAlice, alice, {
        teamId: team.id,
        title: unique('Talked about'),
      });
      const comment = unique('Seen on staging too');

      await gotoTeamIssues(page, alice, team);
      await openIssue(page, issue.title);

      await page
        .getByRole('tabpanel')
        .locator('[contenteditable="true"]')
        .click();
      await page.keyboard.type(comment);

      if (how === 'Cmd+Enter') {
        await page.keyboard.press('ControlOrMeta+Enter');
      } else {
        await page.getByRole('button', { name: 'Send comment' }).click();
      }

      await expect(page.getByRole('tabpanel')).toContainText(comment);
      await expect
        .poll(async () =>
          (await commentsOn(asAlice, issue.id)).map((each) =>
            each.bodyMarkdown.trim(),
          ),
        )
        .toEqual([comment]);
    });
  }

  test('closing the sheet leaves the list', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const issue = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Opened and closed'),
    });

    await gotoTeamIssues(page, alice, team);
    await openIssue(page, issue.title);
    await page.getByRole('button', { name: 'Close issue' }).click();

    await expect(
      page.getByRole('button', { name: 'Close issue' }),
    ).toBeHidden();
    await expect(issueRow(page, issue.title)).toBeVisible();
  });
});

/**
 * The title and description save a moment after the last keystroke, so the
 * sheet can close, or move to another issue, while an edit is still waiting.
 */
test.describe('an edit made just before leaving', () => {
  test('is kept when the sheet closes', async ({ page, asAlice, alice }) => {
    const team = await createSpareTeam(asAlice);
    const issue = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Edited then closed'),
    });
    const description = unique('Typed a moment before closing');

    await gotoTeamIssues(page, alice, team);
    await openIssue(page, issue.title);
    await page.locator('.ProseMirror').first().click();
    await page.keyboard.type(description);
    await page.getByRole('button', { name: 'Close issue' }).click();

    await expect
      .poll(async () => (await getIssue(asAlice, issue.id)).description ?? '')
      .toContain(description);
  });

  test('is kept, in the issue it was made in, when another opens', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const edited = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Edited then left'),
    });
    const next = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Opened next'),
    });
    const description = unique('Belongs to the first issue only');

    await gotoTeamIssues(page, alice, team);
    await openIssue(page, edited.title);
    await page.locator('.ProseMirror').first().click();
    await page.keyboard.type(description);
    await openIssue(page, next.title);

    await expect
      .poll(async () => (await getIssue(asAlice, edited.id)).description ?? '')
      .toContain(description);
    // Longer than any save waits, then make sure it never landed here.
    await page.waitForTimeout(2_000);
    expect((await getIssue(asAlice, next.id)).description ?? '').not.toContain(
      description,
    );
  });

  test('keeps a new title when the sheet closes', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const issue = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Renamed then closed'),
    });

    await gotoTeamIssues(page, alice, team);
    await openIssue(page, issue.title);
    await page.getByRole('textbox', { name: 'Issue title' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' for good');
    await page.getByRole('button', { name: 'Close issue' }).click();

    await expect
      .poll(async () => (await getIssue(asAlice, issue.id)).title)
      .toBe(`${issue.title} for good`);
  });
});

/**
 * The page never asks for what changed: the server pushes each write down the
 * socket, from the database's replication stream. When that breaks, as it did
 * when the socket could not verify its session, nothing fails; the page just
 * stops changing until a reload.
 */
test.describe('live updates', () => {
  test('an issue made elsewhere appears without a reload', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    // The list draws only once there is something in it.
    await createIssue(asAlice, alice, { teamId: team.id });
    await gotoTeamIssues(page, alice, team);

    const title = unique('Arrived live');
    await createIssue(asAlice, alice, { teamId: team.id, title });

    await expect(issueRow(page, title)).toBeVisible({ timeout: 15_000 });
  });

  test('a change made elsewhere shows without a reload', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const issue = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Renamed live'),
    });

    await gotoTeamIssues(page, alice, team);
    await expect(issueRow(page, issue.title)).toBeVisible();

    const renamed = `${issue.title} (renamed)`;
    await updateIssue(asAlice, issue, { title: renamed });

    await expect(issueRow(page, renamed)).toBeVisible({ timeout: 15_000 });
  });

  // A change is pushed only to a socket connected at the moment it happens.
  // One made while the page was still connecting, or reconnecting after a
  // drop, never arrived until a reload; a comment sent from the sheet went
  // missing that way.
  test('a change made while the socket was down arrives once it connects', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const issue = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Talked about while away'),
    });
    const text = unique('Posted while the page was away');

    // Refused, the socket keeps trying again, a few seconds apart.
    const socket = '**/socket.io/**';
    await page.route(socket, (route) => route.abort());
    await gotoTeamIssues(page, alice, team);
    await openIssue(page, issue.title);

    const since = await cursor(asAlice);
    const comment = await createComment(asAlice, issue.id, text);
    // Announced, and so gone for good for a socket that was not there.
    await synced(asAlice, since, 'IssueComment', comment.id, 'I');
    await page.unroute(socket);

    await expect(page.getByRole('tabpanel')).toContainText(text, {
      timeout: 20_000,
    });
  });
});
