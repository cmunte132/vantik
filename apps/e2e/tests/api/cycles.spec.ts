import {
  createCycle,
  createIssue,
  createSpareTeam,
  getIssue,
  stateNamed,
  teamsOf,
} from '../../src/api';
import { expect, test } from '../../src/fixtures';
import { bootstrap } from '../../src/sync';

/**
 * A cycle is a team's sprint. Each test uses a spare team of its own, because
 * a team has at most one current cycle and the tests would otherwise race for
 * it.
 */

test.describe('cycles', () => {
  test('an issue filed into a cycle keeps it', async ({ asAlice, alice }) => {
    const team = await createSpareTeam(asAlice);
    const cycle = await createCycle(asAlice, team.id);

    // Creating an issue with a cycle once answered 500.
    const issue = await createIssue(asAlice, alice, { teamId: team.id, cycleId: cycle.id });

    expect((await getIssue(asAlice, issue.id)).cycleId).toBe(cycle.id);
  });

  test('completing a cycle moves its unfinished issues to the next one', async ({
    asAlice,
    alice,
  }) => {
    const team = await createSpareTeam(asAlice);
    const current = await createCycle(asAlice, team.id);
    const next = await createCycle(asAlice, team.id, 7);

    const started = await asAlice.post(`/v1/cycles/${current.id}/start`);
    expect(started, await started.text()).toBeOK();

    const done = await stateNamed(asAlice, team.id, 'Done');
    const unfinished = await createIssue(asAlice, alice, {
      teamId: team.id,
      cycleId: current.id,
    });
    const finished = await createIssue(asAlice, alice, {
      teamId: team.id,
      cycleId: current.id,
      stateId: done.id,
    });

    const completed = await asAlice.post(`/v1/cycles/${current.id}/complete`, {
      data: { unfinishedDestination: 'next-cycle' },
    });
    expect(completed, await completed.text()).toBeOK();

    expect((await getIssue(asAlice, unfinished.id)).cycleId).toBe(next.id);
    expect((await getIssue(asAlice, finished.id)).cycleId).toBe(current.id);

    // Completing promotes the next cycle, and the team points at it. The
    // webapp learns a cycle's status through sync, so that is where it is read.
    await expect
      .poll(async () =>
        Object.fromEntries(
          (await bootstrap(asAlice, ['Cycle'])).syncActions
            .filter((record) => record.data.teamId === team.id)
            .map((record) => [record.modelId, record.data.status]),
        ),
      )
      .toEqual({ [current.id]: 'COMPLETED', [next.id]: 'CURRENT' });

    const saved = (await teamsOf(asAlice)).find((candidate) => candidate.id === team.id);
    expect(saved?.currentCycle).toBe(next.number);
  });
});
