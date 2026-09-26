import { createIssue, deleteIssue, issuesOf, updateIssue, unique } from '../../src/api';
import { expect, knownBug, test } from '../../src/fixtures';
import {
  bootstrap,
  bootstrapIds,
  cursor,
  delta,
  synced,
  WEBAPP_MODELS,
} from '../../src/sync';

/**
 * The webapp does not read issues from the REST API. It asks the sync API for
 * everything once (the bootstrap), then for what changed (the delta), and keeps
 * the answer in IndexedDB. So a change that never reaches the sync log never
 * reaches a screen, and a record the bootstrap hands out by mistake stays on
 * someone's disk. These tests read what the webapp reads.
 */

test.describe('sync', () => {
  test('the bootstrap and the delta answer for every model the webapp asks for', async ({
    asAlice,
  }) => {
    const first = await bootstrap(asAlice, WEBAPP_MODELS);
    expect(first.lastSequenceId).toMatch(/^\d+$/);

    const next = await delta(asAlice, first.lastSequenceId, WEBAPP_MODELS);
    expect(next.resync).toBeFalsy();
  });

  test('a new issue, its edit and its deletion each reach the delta', async ({
    asAlice,
    alice,
  }) => {
    const since = await cursor(asAlice);

    const issue = await createIssue(asAlice, alice);
    const inserted = await synced(asAlice, since, 'Issue', issue.id, 'I');
    expect(inserted.data.title).toBe(issue.title);
    expect(inserted.data.teamId).toBe(alice.teamId);

    const title = unique('Renamed');
    await updateIssue(asAlice, issue, { title });
    const updated = await synced(asAlice, since, 'Issue', issue.id, 'U');
    expect(updated.data.title).toBe(title);

    await deleteIssue(asAlice, issue);
    await synced(asAlice, since, 'Issue', issue.id, 'D');
  });

  test('a deleted issue is not in the next bootstrap', async ({ asAlice, alice }) => {
    const since = await cursor(asAlice);
    const kept = await createIssue(asAlice, alice);
    const deleted = await createIssue(asAlice, alice);
    await synced(asAlice, since, 'Issue', deleted.id, 'I');

    await deleteIssue(asAlice, deleted);
    await synced(asAlice, since, 'Issue', deleted.id, 'D');

    // The bootstrap once kept the insert and dropped the later delete, so a
    // deleted issue came back on every fresh load and could not be removed.
    const ids = await bootstrapIds(asAlice, 'Issue');
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(deleted.id);
  });

  test('the bootstrap holds the issues the API lists', async ({ asAlice, alice }) => {
    const since = await cursor(asAlice);
    const issue = await createIssue(asAlice, alice);
    await synced(asAlice, since, 'Issue', issue.id, 'I');


    // Other tests write to this workspace at the same time. So the two are
    // compared on the issues listed both before and after the bootstrap, and
    // polled: an issue created a moment ago may not have replicated yet.
    const missingFromBootstrap = async () => {
      const listed = new Set((await issuesOf(asAlice)).map((i) => i.id));
      const bootstrapped = new Set(await bootstrapIds(asAlice, 'Issue'));
      const relisted = (await issuesOf(asAlice)).map((i) => i.id);

      return relisted.filter((id) => listed.has(id) && !bootstrapped.has(id));
    };

    expect(await bootstrapIds(asAlice, 'Issue')).toContain(issue.id);
    await expect
      .poll(missingFromBootstrap, {
        message: 'issues the API lists that the bootstrap leaves out',
        timeout: 20_000,
      })
      .toEqual([]);
  });

  test('a cursor the server has not reached asks the client to start again', async ({
    asAlice,
  }) => {
    // What a client holds after the server's database is restored from an
    // older backup. An empty delta would leave it confidently wrong.
    const ahead = await delta(asAlice, '99999999999999999999', ['Issue']);

    expect(ahead.resync).toBe(true);
    expect(ahead.syncActions).toEqual([]);
  });

  test('a cursor that is not a number is refused rather than crashing', async ({
    asAlice,
  }) => {
    const response = await asAlice.get('/v1/sync_actions/delta', {
      params: { modelNames: 'Issue', lastSequenceId: 'yesterday' },
    });

    knownBug('the delta converts the cursor with BigInt() before validating it, and answers 500');

    expect(response.status()).toBe(400);
  });
});

test.describe('sync across workspaces', () => {
  test("Bob cannot ask for Alice's workspace", async ({ asBob, alice }) => {
    // The refusal below is a 401, which a broken token would also get. So
    // first, Bob's token works for his own workspace.
    await bootstrap(asBob, ['Issue']);

    const params = {
      modelNames: 'Issue',
      workspaceId: alice.workspaceId,
    };

    expect(
      (await asBob.get('/v1/sync_actions/bootstrap', { params })).status(),
    ).toBe(401);
    expect(
      (
        await asBob.get('/v1/sync_actions/delta', {
          params: { ...params, lastSequenceId: '0' },
        })
      ).status(),
    ).toBe(401);
  });

  test("Bob's bootstrap holds nothing of Alice's", async ({ asAlice, asBob, alice }) => {
    const since = await cursor(asAlice);
    const issue = await createIssue(asAlice, alice);
    // Only once Alice's own sync has the issue does its absence from Bob's
    // mean anything.
    await synced(asAlice, since, 'Issue', issue.id, 'I');

    const bobs = await bootstrap(asBob);

    expect(bobs.syncActions.map((record) => record.modelId)).not.toContain(issue.id);
    expect(
      bobs.syncActions.filter((record) => record.workspaceId === alice.workspaceId),
    ).toEqual([]);
  });
});
