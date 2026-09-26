import type { APIRequestContext, APIResponse } from '@playwright/test';

import { createIssue, createSpareTeam, moveIssue } from '../../src/api';
import { answerInvite, invite, inviteIdFor, signIn } from '../../src/auth';
import { runTag } from '../../src/env';
import { expect, knownBug, test } from '../../src/fixtures';
import { messageIdsTo, readEmail } from '../../src/mailpit';
import { bootstrap, bootstrapIds, cursor, delta, synced } from '../../src/sync';

/**
 * Carol is in Alice's workspace, invited to one team (CRL) and not to Alice's
 * own (ALC). A team is a visibility boundary: what Carol's client is sent from
 * a team she is not in is on her disk, whatever the screens then draw.
 */

function expectRefused(response: APIResponse, what: string) {
  expect([403, 404], `${what} answered ${response.status()}`).toContain(
    response.status(),
  );
}

/**
 * Waits until the sync log has an update filed under `teamId` for the issue.
 * The record's `data` is read live, so it shows the new team as soon as the
 * move commits; the log entry's own team is what says the move has replicated.
 */
async function movedInLog(
  asAlice: APIRequestContext,
  since: string,
  issueId: string,
  teamId: string,
) {
  await expect
    .poll(
      async () =>
        (await delta(asAlice, since, ['Issue'])).syncActions.some(
          (record) =>
            record.modelId === issueId && record.action === 'U' && record.teamId === teamId,
        ),
      { message: `issue ${issueId} never synced in team ${teamId}`, timeout: 20_000 },
    )
    .toBe(true);
}

test.describe('the team boundary', () => {
  test("a teammate is sent their own team's issues", async ({
    asAlice,
    asCarol,
    alice,
    carol,
  }) => {
    const since = await cursor(asCarol);
    const issue = await createIssue(asAlice, alice, { teamId: carol.teamId });

    await synced(asCarol, since, 'Issue', issue.id, 'I');
    expect(await bootstrapIds(asCarol, 'Issue')).toContain(issue.id);
    expect(await asCarol.get(`/v1/issues/${issue.id}`)).toBeOK();
  });

  test('a teammate is sent nothing from a team they are not in', async ({
    asAlice,
    asCarol,
    alice,
  }) => {
    const aliceSince = await cursor(asAlice);
    const carolSince = await cursor(asCarol);
    const issue = await createIssue(asAlice, alice);

    // Only once Alice's own sync has it does its absence from Carol's mean
    // anything.
    await synced(asAlice, aliceSince, 'Issue', issue.id, 'I');

    expect(await bootstrapIds(asCarol, 'Issue')).not.toContain(issue.id);
    expect(
      (await delta(asCarol, carolSince, ['Issue'])).syncActions.map((r) => r.modelId),
    ).not.toContain(issue.id);
    expectRefused(await asCarol.get(`/v1/issues/${issue.id}`), 'GET /v1/issues/:id');
  });

  test("an issue moved out of a teammate's team stops reaching them", async ({
    asAlice,
    asCarol,
    alice,
    carol,
  }) => {
    const aliceSince = await cursor(asAlice);
    const carolSince = await cursor(asCarol);
    const issue = await createIssue(asAlice, alice, { teamId: carol.teamId });
    await synced(asCarol, carolSince, 'Issue', issue.id, 'I');

    await moveIssue(asAlice, issue, alice.teamId);
    await movedInLog(asAlice, aliceSince, issue.id, alice.teamId);

    expectRefused(await asCarol.get(`/v1/issues/${issue.id}`), 'GET /v1/issues/:id');

    knownBug(
      "a move files only the issue's update under its new team; its insert stays under the old one, so the old team's bootstrap still serves it, with its current data",
    );

    expect(await bootstrapIds(asCarol, 'Issue')).not.toContain(issue.id);
  });
});

test.describe('notifications', () => {
  test('a teammate assigned an issue is notified in the app', async ({
    asAlice,
    asCarol,
    alice,
    carol,
  }) => {
    const issue = await createIssue(asAlice, alice, {
      teamId: carol.teamId,
      assigneeId: carol.userId,
    });

    await expect
      .poll(
        async () =>
          (await bootstrap(asCarol, ['Notification'])).syncActions.some(
            (record) =>
              record.data.issueId === issue.id && record.data.type === 'IssueAssigned',
          ),
        { message: 'Carol was never notified of the assignment', timeout: 30_000 },
      )
      .toBe(true);
  });

  test('a teammate assigned an issue is emailed', async ({
    request,
    asAlice,
    asCarol,
    alice,
    carol,
  }) => {
    const seen = await messageIdsTo(request, carol.email);
    const issue = await createIssue(asAlice, alice, {
      teamId: carol.teamId,
      assigneeId: carol.userId,
    });

    // The in-app notification and the email are delivered by the same job, so
    // once the first is there the second has been attempted.
    await expect
      .poll(
        async () =>
          (await bootstrap(asCarol, ['Notification'])).syncActions.some(
            (record) => record.data.issueId === issue.id,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    // Other tests assign Carol issues too, at the same time.
    const email = await readEmail(
      request,
      carol.email,
      /assigned an issue to you/,
      seen,
      15_000,
      issue.title,
    );
    expect(email.html).toContain(issue.title);
  });
});

test.describe('a notification', () => {
  // The route updated the row by id alone, so anyone signed in could mark
  // anyone's notification read or snooze it, in any workspace.
  test('is marked read by the person it was sent to, and no one else', async ({
    asAlice,
    asCarol,
    alice,
    carol,
  }) => {
    const issue = await createIssue(asAlice, alice, {
      teamId: carol.teamId,
      assigneeId: carol.userId,
    });

    let notificationId: string | undefined;
    await expect
      .poll(
        async () => {
          notificationId = (await bootstrap(asCarol, ['Notification'])).syncActions.find(
            (record) => record.data.issueId === issue.id,
          )?.modelId;
          return notificationId;
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();

    const readAt = new Date().toISOString();
    const byAlice = await asAlice.post(`/v1/notifications/${notificationId}`, {
      data: { readAt },
    });
    expect(byAlice.status()).toBe(404);

    const byCarol = await asCarol.post(`/v1/notifications/${notificationId}`, {
      data: { readAt },
    });
    expect(byCarol).toBeOK();
  });
});

test.describe('invites', () => {
  test('an invite is accepted only by the person it was sent to', async ({
    request,
    asAlice,
    alice,
  }) => {
    const tag = runTag();
    const invitee = `dave+${tag}@e2e.vantik.test`;
    // Someone with an account but no business in Alice's workspace. Not Bob:
    // if this hole is open, whoever tries it joins Alice's workspace, and Bob
    // has to stay out of it for every other test.
    const outsider = `eve+${tag}@e2e.vantik.test`;

    const team = await createSpareTeam(asAlice);
    await invite(request, alice, invitee, team.id);
    const { session: daves } = await signIn(request, invitee);
    const inviteId = await inviteIdFor(request, daves, alice.workspaceId);

    const { session: eves } = await signIn(request, outsider);
    const taken = await answerInvite(request, eves, inviteId);

    expect(taken.ok(), `accepting someone else's invite answered ${taken.status()}`).toBe(
      false,
    );
    const evesWorkspaces = await request.get('/v1/workspaces', {
      headers: { authorization: `Bearer ${eves.accessToken}` },
    });
    expect(evesWorkspaces).toBeOK();
    expect(
      ((await evesWorkspaces.json()) as Array<{ id: string }>).map((w) => w.id),
    ).not.toContain(alice.workspaceId);

    // And the invite is still Dave's to accept.
    expect(await answerInvite(request, daves, inviteId)).toBeOK();
  });

  test('a declined invite cannot be accepted after', async ({
    request,
    asAlice,
    alice,
  }) => {
    const invitee = `frank+${runTag()}@e2e.vantik.test`;
    const team = await createSpareTeam(asAlice);
    await invite(request, alice, invitee, team.id);
    const { session } = await signIn(request, invitee);
    const inviteId = await inviteIdFor(request, session, alice.workspaceId);

    expect(await answerInvite(request, session, inviteId, false)).toBeOK();

    // The invite was found by id alone, declined or not.
    const accepted = await answerInvite(request, session, inviteId);
    expect(accepted.status()).toBe(404);
  });
});
