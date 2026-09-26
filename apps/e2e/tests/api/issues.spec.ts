import {
  commentsOn,
  createComment,
  createIssue,
  createLabel,
  getIssue,
  issuesOf,
  stateNamed,
  unique,
  updateIssue,
} from '../../src/api';
import { expect, test } from '../../src/fixtures';

test.describe('issues', () => {
  test('a description written as markdown reads back as markdown', async ({
    asAlice,
    alice,
  }) => {
    // After the Tiptap 3 upgrade the built server read every description as ''
    // and failed every markdown write, because the package's default entry is
    // a browser build. Typecheck and the unit tests were green throughout;
    // only the running server showed it.
    const markdown = [
      '## Root cause',
      '',
      'The **pool** was _retried_ until it ~~recovered~~ gave up.',
      '',
      '- raise `max_connections`',
      '- add a timeout',
    ].join('\n');

    const created = await createIssue(asAlice, alice, { descriptionMarkdown: markdown });
    const fetched = await getIssue(asAlice, created.id);

    for (const issue of [created, fetched]) {
      expect(issue.descriptionMarkdown).toContain('## Root cause');
      expect(issue.descriptionMarkdown).toContain('**pool**');
      expect(issue.descriptionMarkdown).toContain('_retried_');
      expect(issue.descriptionMarkdown).toContain('~~recovered~~');
      expect(issue.descriptionMarkdown).toContain('`max_connections`');
      expect(issue.descriptionMarkdown).toContain('add a timeout');
    }

    // The stored form is the editor's document, which is what the webapp reads.
    const document = JSON.parse(fetched.description!);
    expect(document.type).toBe('doc');
  });

  test('an issue can be retitled and moved to another state', async ({
    asAlice,
    alice,
  }) => {
    const issue = await createIssue(asAlice, alice);
    const inProgress = await stateNamed(asAlice, alice.teamId, 'In Progress');
    const title = unique('Retitled');

    const response = await asAlice.post(`/v1/issues/${issue.id}`, {
      params: { teamId: alice.teamId },
      data: { title, stateId: inProgress.id },
    });
    expect(response).toBeOK();

    const fetched = await getIssue(asAlice, issue.id);
    expect(fetched.title).toBe(title);
    expect(fetched.stateId).toBe(inProgress.id);
  });

  test('issues are numbered within their team and found by number', async ({
    asAlice,
    alice,
  }) => {
    const first = await createIssue(asAlice, alice);
    const second = await createIssue(asAlice, alice);
    expect(second.number).toBeGreaterThan(first.number);

    const response = await asAlice.get(`/v1/issues/number/${second.number}`, {
      params: { teamId: alice.teamId },
    });
    expect(response).toBeOK();
    expect((await response.json()).id).toBe(second.id);
  });

  test('a comment is listed on its issue', async ({ asAlice, alice }) => {
    const issue = await createIssue(asAlice, alice);
    const text = unique('A comment');

    const comment = await createComment(asAlice, issue.id, text);

    const listed = (await commentsOn(asAlice, issue.id)).find(
      (c) => c.id === comment.id,
    );
    expect(listed, 'the new comment is not listed').toBeTruthy();
    expect(listed!.bodyMarkdown).toContain(text);
  });

  test('a deleted issue is gone from the list and cannot be read', async ({
    asAlice,
    alice,
  }) => {
    const issue = await createIssue(asAlice, alice);
    expect((await issuesOf(asAlice)).map((i) => i.id)).toContain(issue.id);

    const response = await asAlice.delete(`/v1/issues/${issue.id}`, {
      params: { teamId: alice.teamId },
    });
    expect(response).toBeOK();

    // Deletion is soft, so the row is still there to be served by mistake.
    expect((await issuesOf(asAlice)).map((i) => i.id)).not.toContain(issue.id);
    expect((await asAlice.get(`/v1/issues/${issue.id}`)).status()).toBe(404);
  });
});

/**
 * The webapp saves an issue one property at a time, so an update carries only
 * what changed. The validation pipe used to hand the handler every field the
 * DTO declares, the unsent ones as undefined, and the handler read those as
 * sent: an update tried to connect a parent, a project and a cycle of
 * undefined, and answered 500.
 */
test.describe('updating an issue', () => {
  test('changes only the fields the request sends', async ({ asAlice, alice }) => {
    const label = await createLabel(asAlice, alice);
    const issue = await createIssue(asAlice, alice, {
      descriptionMarkdown: 'Left as it was',
      priority: 2,
      labelIds: [label.id],
      assigneeId: alice.userId,
    });

    await updateIssue(asAlice, issue, { priority: 1 });

    expect(await getIssue(asAlice, issue.id)).toMatchObject({
      priority: 1,
      title: issue.title,
      description: issue.description,
      stateId: issue.stateId,
      labelIds: [label.id],
      assigneeId: alice.userId,
      parentId: null,
      projectId: null,
      cycleId: null,
    });
  });

  test('clears a field the request sends as null', async ({ asAlice, alice }) => {
    const issue = await createIssue(asAlice, alice, { assigneeId: alice.userId });

    await updateIssue(asAlice, issue, { assigneeId: null });

    expect((await getIssue(asAlice, issue.id)).assigneeId).toBeNull();
  });

  // The body is whitelisted against the DTO: a field it does not declare, like
  // the issue number, is dropped rather than written.
  test('ignores a field the update does not declare', async ({ asAlice, alice }) => {
    const issue = await createIssue(asAlice, alice);
    const title = unique('Renamed');

    const response = await asAlice.post(`/v1/issues/${issue.id}`, {
      params: { teamId: issue.teamId },
      data: { title, number: issue.number + 1000 },
    });
    expect(response).toBeOK();

    expect(await getIssue(asAlice, issue.id)).toMatchObject({
      title,
      number: issue.number,
    });
  });

  // A team named in the body has to be one of the caller's, as the one in the
  // query does. Otherwise the body could carry an issue off.
  test("refuses a team that is not the caller's", async ({ asAlice, alice, bob }) => {
    const issue = await createIssue(asAlice, alice);

    const response = await asAlice.post(`/v1/issues/${issue.id}`, {
      params: { teamId: issue.teamId },
      data: { title: unique('Carried off'), teamId: bob.teamId },
    });
    expect(response.status()).toBe(404);

    expect(await getIssue(asAlice, issue.id)).toMatchObject({
      title: issue.title,
      teamId: issue.teamId,
    });
  });

  test('refuses a field of the wrong type', async ({ asAlice, alice }) => {
    const issue = await createIssue(asAlice, alice);

    const response = await asAlice.post(`/v1/issues/${issue.id}`, {
      params: { teamId: issue.teamId },
      data: { priority: 'high' },
    });
    expect(response.status()).toBe(400);
  });
});
