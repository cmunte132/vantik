import { createSpareTeam } from '../../src/api';
import { expect, test } from '../../src/fixtures';

test.describe('teams', () => {
  // Making a team adds its maker to it, by adding the team to their list of
  // teams. That list was read and written back whole, so of teams made at
  // once, the maker ended up in only some. Every route scoped to the others
  // then answered 404, though they had just made them.
  test('someone who makes several teams at once is in every one', async ({
    asAlice,
    alice,
  }) => {
    const teams = await Promise.all(
      Array.from({ length: 6 }, () => createSpareTeam(asAlice)),
    );

    for (const team of teams) {
      const roster = await asAlice.get(`/v1/teams/${team.id}/members`);
      expect(roster).toBeOK();
      const members = (await roster.json()) as Array<{ userId: string }>;
      expect(
        members.map((member) => member.userId),
        `Alice is not in ${team.identifier}, which she made`,
      ).toContain(alice.userId);
    }
  });
});
