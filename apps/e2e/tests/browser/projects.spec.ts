import {
  createIssue,
  createProject,
  createSpareTeam,
  getIssue,
  projects,
  unique,
} from '../../src/api';
import {
  gotoTeamIssues,
  openIssue,
  propertyControl,
  setProperty,
} from '../../src/browser';
import { expect, test } from '../../src/fixtures';

test.describe('projects', () => {
  test('a project made in its dialog is saved with the team picked for it', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const name = unique('Made in the dialog');
    const description = unique('What this project is for');

    await page.goto(`/${alice.workspaceSlug}/projects`);
    await page.getByRole('button', { name: 'Create project' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // The title has the focus when the dialog opens.
    await page.keyboard.type(name);
    await dialog.locator('.ProseMirror').click();
    await page.keyboard.type(description);

    // The dialog starts with one of Alice's teams picked, and a project must
    // keep one, so pick the spare team first and then drop the other. Of its
    // two pickers, the status one starts at Backlog.
    await dialog.getByRole('combobox').filter({ hasNotText: 'Backlog' }).first().click();
    const options = page.getByRole('option');
    const preselected = options.filter({
      has: page.getByRole('checkbox', { checked: true }),
    });
    await expect(preselected).toHaveCount(1);
    const preselectedName = (await preselected.innerText()).trim();

    // Alice has more teams than fit in the list, so find this one by name. The
    // box used to filter nothing, and a team past the screen's edge was out of
    // reach. Ticking one then lost the page: see TeamsDropdown's portal.
    const search = page.getByPlaceholder('Set teams...');
    await search.fill(team.name);
    await expect(options).toHaveText([team.name]);
    await options.click();
    await search.fill(preselectedName);
    await options.filter({ hasText: preselectedName }).first().click();
    await search.fill('');
    await expect(
      options.filter({ has: page.getByRole('checkbox', { checked: true }) }),
    ).toHaveText([team.name]);
    // The picker is a dialog too, so it has to be gone before `dialog` means
    // the project's alone again.
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();

    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(name)).toBeVisible();

    await expect
      .poll(async () => (await projects(asAlice)).find((project) => project.name === name))
      .toMatchObject({
        teams: [team.id],
        description: expect.stringContaining(description),
      });
  });

  test('the side sheet puts an issue in a project', async ({
    page,
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const project = await createProject(asAlice, {
      name: unique('Holds an issue'),
      teams: [team.id],
    });
    const issue = await createIssue(asAlice, alice, {
      teamId: team.id,
      title: unique('Belongs in a project'),
    });

    await gotoTeamIssues(page, alice, team);
    await openIssue(page, issue.title);
    await setProperty(page, 'Project', project.name);
    // Choosing one closes the picker. It renders inside the property rather
    // than in a portal, so until it has gone it is a second combobox there.
    await expect(page.getByPlaceholder('Set project...')).toBeHidden();

    await expect(propertyControl(page, 'Project')).toHaveText(project.name);
    await expect
      .poll(async () => (await getIssue(asAlice, issue.id)).projectId)
      .toBe(project.id);
  });
});
