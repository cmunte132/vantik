import {
  createComment,
  createIssue,
  getIssue,
  stateNamed,
  unique,
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

    const response = await asAlice.get(`/v1/issues/${issue.id}/comments`);
    expect(response).toBeOK();
    const comments: Array<{ id: string; bodyMarkdown: string }> =
      await response.json();
    const listed = comments.find((c) => c.id === comment.id);
    expect(listed, 'the new comment is not listed').toBeTruthy();
    expect(listed!.bodyMarkdown).toContain(text);
  });

  test('a deleted issue is gone from the team list', async ({ asAlice, alice }) => {
    const issue = await createIssue(asAlice, alice);

    const response = await asAlice.delete(`/v1/issues/${issue.id}`, {
      params: { teamId: alice.teamId },
    });
    expect(response).toBeOK();

    const list = await asAlice.get('/v1/issues', { params: { teamId: alice.teamId } });
    expect(list).toBeOK();
    const ids = ((await list.json()) as Array<{ id: string }>).map((i) => i.id);
    expect(ids).not.toContain(issue.id);
  });
});
