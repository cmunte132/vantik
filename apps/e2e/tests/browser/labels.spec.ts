import { labelsOf, unique } from '../../src/api';
import { expect, test } from '../../src/fixtures';

test.describe('labels', () => {
  test('a label made in settings is saved', async ({ page, asAlice, alice }) => {
    const name = unique('Regression');

    await page.goto(`/${alice.workspaceSlug}/settings/labels`);
    await page.getByRole('button', { name: 'New label' }).click();
    await page.getByPlaceholder('Label name').fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText(name)).toBeVisible();
    await expect
      .poll(async () => (await labelsOf(asAlice, alice)).map((label) => label.name))
      .toContain(name);
  });
});
