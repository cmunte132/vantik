import { createSpareTeam, teamsOf, workspacesOf } from '../../src/api';
import { expect, test } from '../../src/fixtures';

/**
 * A settings form saves part of a record and expects the rest to stay. The
 * server's validation has broken that more than once: it handed a handler every
 * field the form did not send as `undefined`, and a handler that spreads the
 * body over the stored value wiped them. Each test here saves, then reads the
 * record back the way the webapp does, and checks that what was saved stuck
 * and nothing else moved.
 */

test.describe('settings are saved', () => {
  test('saving part of a team\'s settings keeps the rest', async ({ asAlice }) => {
    // A spare team, because this changes its settings.
    const team = await createSpareTeam(asAlice, {
      preferences: { teamType: 'support', cyclesFrequency: 3 },
    });
    expect(team.preferences).toMatchObject({ teamType: 'support', cyclesFrequency: 3 });

    // What the cycles settings screen sends: only the fields on it.
    const first = await asAlice.post(`/v1/teams/${team.id}/preferences`, {
      data: { cyclesEnabled: true, cyclesMode: 'manual' },
    });
    expect(first).toBeOK();
    const second = await asAlice.post(`/v1/teams/${team.id}/preferences`, {
      data: { upcomingCycles: 2 },
    });
    expect(second).toBeOK();

    const saved = (await teamsOf(asAlice)).find((candidate) => candidate.id === team.id);
    expect(saved?.preferences).toEqual(
      expect.objectContaining({
        teamType: 'support',
        cyclesFrequency: 3,
        cyclesEnabled: true,
        cyclesMode: 'manual',
        upcomingCycles: 2,
      }),
    );
  });

  test('the agent settings of a workspace are saved', async ({ asAlice, alice }) => {
    const maxCostUsd = Math.floor(Math.random() * 90) + 10;
    const agentRuns = { phases: { review: true }, limits: { maxCostUsd } };

    // What the Agents settings page sends.
    const response = await asAlice.post('/v1/workspaces/preferences', {
      data: { agentRuns },
    });
    expect(response).toBeOK();

    const workspace = (await workspacesOf(asAlice)).find(
      (candidate) => candidate.id === alice.workspaceId,
    );
    expect(workspace?.preferences).toEqual(expect.objectContaining({ agentRuns }));

    // The page shows what the save returns, so that has to be the saved row.
    expect((await response.json()).preferences).toEqual(
      expect.objectContaining({ agentRuns }),
    );
  });
});
