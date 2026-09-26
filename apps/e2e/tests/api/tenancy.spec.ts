import type { APIResponse } from '@playwright/test';

import {
  createComment,
  createIssue,
  createLabel,
  createMilestone,
  createProject,
  createSpareTeam,
  createView,
  getIssue,
  getTeam,
  getView,
  labelsOf,
  projects,
  stateNamed,
  unique,
  workflows,
} from '../../src/api';
import { expect, test } from '../../src/fixtures';

/**
 * Alice and Bob each own a workspace. Nothing Bob does may read or change
 * anything of Alice's. This is the class of bug that has reached main most
 * often: a route behind AuthGuard alone serves any row to any signed-in user.
 *
 * Each test makes its own records, so a hole that lets Bob rename or delete
 * something cannot break a test running beside it.
 */

/**
 * A refusal for a record in someone else's workspace. The resource guard
 * answers 404 so as not to confirm the record exists, and the admin guard 403.
 * 401 is deliberately not accepted here: it would also be what a broken token
 * gets, and then every one of these would pass for the wrong reason.
 */
function expectRefused(response: APIResponse, what: string) {
  expect([403, 404], `${what} answered ${response.status()}`).toContain(
    response.status(),
  );
}

/**
 * Marks a hole that is known and not yet closed on main. `test.fail` inverts
 * the result, so the suite stays green while the hole is open and goes red with
 * "expected to fail, but passed" the moment it is closed — which is the prompt
 * to delete the call.
 */
function knownHole(fixedBy: string) {
  test.fail(true, `Known hole on main, closed by ${fixedBy}`);
}

const PR_35 = 'https://github.com/cmunte132/vantik/pull/35';
const VIEWS_OPEN = 'nothing yet: the view routes take an id and never check its workspace';

test.describe('the workspace boundary', () => {
  test("Bob's own credentials work, so a refusal below is about Alice's records", async ({
    asBob,
    bob,
  }) => {
    const issue = await createIssue(asBob, bob);
    expect((await asBob.get(`/v1/issues/${issue.id}`)).status()).toBe(200);
    expect((await asBob.get(`/v1/teams/${bob.teamId}`)).status()).toBe(200);
  });

  test.describe('issues', () => {
    test("Bob cannot read Alice's issue or anything hanging off it", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      const issue = await createIssue(asAlice, alice);

      for (const suffix of ['', '/comments', '/history', '/context']) {
        expectRefused(
          await asBob.get(`/v1/issues/${issue.id}${suffix}`),
          `GET /v1/issues/:id${suffix}`,
        );
      }
      expectRefused(
        await asBob.get(`/v1/issues/number/${issue.number}`, {
          params: { teamId: alice.teamId },
        }),
        'GET /v1/issues/number/:n',
      );
    });

    test("Bob cannot edit, move or delete Alice's issue", async ({
      asAlice,
      asBob,
      alice,
      bob,
    }) => {
      const issue = await createIssue(asAlice, alice);

      expectRefused(
        await asBob.post(`/v1/issues/${issue.id}`, {
          params: { teamId: bob.teamId },
          data: { title: 'Taken over' },
        }),
        'POST /v1/issues/:id',
      );
      expectRefused(
        await asBob.post(`/v1/issues/${issue.id}/move`, {
          data: { teamId: bob.teamId },
        }),
        'POST /v1/issues/:id/move',
      );
      expectRefused(
        await asBob.delete(`/v1/issues/${issue.id}`, {
          params: { teamId: bob.teamId },
        }),
        'DELETE /v1/issues/:id',
      );

      const after = await getIssue(asAlice, issue.id);
      expect(after.title).toBe(issue.title);
      expect(after.teamId).toBe(alice.teamId);
      expect(after.deleted).toBeNull();
    });

    test("Bob cannot file an issue into Alice's team", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      const todo = await stateNamed(asAlice, alice.teamId, 'Todo');
      const title = unique('Planted');

      expectRefused(
        await asBob.post('/v1/issues', {
          data: { teamId: alice.teamId, stateId: todo.id, title },
        }),
        'POST /v1/issues',
      );

      const list = await asAlice.get('/v1/issues', {
        params: { teamId: alice.teamId },
      });
      const titles = ((await list.json()) as Array<{ title: string }>).map(
        (i) => i.title,
      );
      expect(titles).not.toContain(title);
    });

    test("Bob cannot list Alice's issues by naming her workspace", async ({
      asBob,
      alice,
    }) => {
      // Naming a workspace you are not a member of is refused outright.
      const response = await asBob.get('/v1/issues', {
        params: { workspaceId: alice.workspaceId },
      });
      expect(response.status()).toBe(401);
    });
  });

  test.describe('comments', () => {
    test("Bob cannot comment on Alice's issue", async ({ asAlice, asBob, alice }) => {
      const issue = await createIssue(asAlice, alice);

      expectRefused(
        await asBob.post('/v1/issue_comments', {
          params: { issueId: issue.id },
          data: { bodyMarkdown: 'Planted' },
        }),
        'POST /v1/issue_comments',
      );
    });

    test("Bob cannot read, edit or delete Alice's comment", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      const issue = await createIssue(asAlice, alice);
      const text = unique('Original');
      const comment = await createComment(asAlice, issue.id, text);

      expectRefused(
        await asBob.get(`/v1/issue_comments/${comment.id}`),
        'GET /v1/issue_comments/:id',
      );
      expectRefused(
        await asBob.post(`/v1/issue_comments/${comment.id}`, {
          data: { bodyMarkdown: 'Rewritten' },
        }),
        'POST /v1/issue_comments/:id',
      );
      expectRefused(
        await asBob.delete(`/v1/issue_comments/${comment.id}`),
        'DELETE /v1/issue_comments/:id',
      );

      const listed = await asAlice.get(`/v1/issues/${issue.id}/comments`);
      const comments = (await listed.json()) as Array<{
        id: string;
        bodyMarkdown: string;
      }>;
      expect(comments.find((c) => c.id === comment.id)?.bodyMarkdown).toContain(
        text,
      );
    });
  });

  test.describe('teams', () => {
    test("Bob cannot read Alice's team or its members", async ({
      asBob,
      alice,
    }) => {
      expectRefused(await asBob.get(`/v1/teams/${alice.teamId}`), 'GET /v1/teams/:id');
      expectRefused(
        await asBob.get(`/v1/teams/${alice.teamId}/members`),
        'GET /v1/teams/:id/members',
      );
    });

    test("Bob cannot rename Alice's team", async ({ asAlice, asBob }) => {
      knownHole(PR_35);
      const team = await createSpareTeam(asAlice);

      expectRefused(
        await asBob.post(`/v1/teams/${team.id}`, { data: { name: 'Taken over' } }),
        'POST /v1/teams/:id',
      );
      expect((await getTeam(asAlice, team.id)).name).toBe(team.name);
    });

    test("Bob cannot delete Alice's team", async ({ asAlice, asBob }) => {
      knownHole(PR_35);
      const team = await createSpareTeam(asAlice);

      expectRefused(await asBob.delete(`/v1/teams/${team.id}`), 'DELETE /v1/teams/:id');
      expect((await getTeam(asAlice, team.id)).id).toBe(team.id);
    });
  });

  test.describe('workflow states', () => {
    test("Bob cannot list Alice's team's states", async ({ asBob, alice }) => {
      knownHole(PR_35);

      expectRefused(
        await asBob.get(`/v1/${alice.teamId}/workflows`),
        'GET /v1/:teamId/workflows',
      );
    });

    test("Bob cannot rename one of Alice's states", async ({ asAlice, asBob }) => {
      knownHole(PR_35);
      // A spare team, because renaming the main team's "Todo" would break
      // every other test that files an issue into it.
      const team = await createSpareTeam(asAlice);
      const todo = await stateNamed(asAlice, team.id, 'Todo');

      expectRefused(
        await asBob.post(`/v1/${team.id}/workflows/${todo.id}`, {
          data: { name: 'Taken over' },
        }),
        'POST /v1/:teamId/workflows/:id',
      );
      const names = (await workflows(asAlice, team.id)).map((w) => w.name);
      expect(names).toContain('Todo');
    });
  });

  test.describe('labels', () => {
    test("Bob cannot read Alice's label", async ({ asAlice, asBob, alice }) => {
      knownHole(PR_35);
      const label = await createLabel(asAlice, alice);

      expectRefused(await asBob.get(`/v1/labels/${label.id}`), 'GET /v1/labels/:id');
    });

    test("Bob cannot rename or delete Alice's label", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      knownHole(PR_35);
      const label = await createLabel(asAlice, alice);

      expectRefused(
        await asBob.post(`/v1/labels/${label.id}`, { data: { name: 'Taken over' } }),
        'POST /v1/labels/:id',
      );
      expectRefused(await asBob.delete(`/v1/labels/${label.id}`), 'DELETE /v1/labels/:id');

      const after = (await labelsOf(asAlice, alice)).find((l) => l.id === label.id);
      expect(after?.name).toBe(label.name);
    });

    test("Bob cannot list Alice's labels by naming her workspace", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      knownHole(PR_35);
      const label = await createLabel(asAlice, alice);

      const response = await asBob.get('/v1/labels', {
        params: { workspaceId: alice.workspaceId },
      });
      // Refusing and answering with only Bob's own labels are both fine.
      if (response.ok()) {
        const ids = ((await response.json()) as Array<{ id: string }>).map((l) => l.id);
        expect(ids).not.toContain(label.id);
      }
    });

    test("Bob cannot create a label inside Alice's workspace", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      knownHole(PR_35);
      const name = unique('Planted label');

      await asBob.post('/v1/labels', {
        data: { name, color: '#000000', workspaceId: alice.workspaceId },
      });

      const names = (await labelsOf(asAlice, alice)).map((l) => l.name);
      expect(names).not.toContain(name);
    });
  });

  test.describe('projects', () => {
    test("Bob cannot edit or delete Alice's project", async ({ asAlice, asBob }) => {
      const project = await createProject(asAlice);

      expectRefused(
        await asBob.post(`/v1/projects/${project.id}`, { data: { name: 'Taken over' } }),
        'POST /v1/projects/:id',
      );
      expectRefused(
        await asBob.delete(`/v1/projects/${project.id}`),
        'DELETE /v1/projects/:id',
      );

      const after = (await projects(asAlice)).find((p) => p.id === project.id);
      expect(after?.name).toBe(project.name);
    });

    test("Bob cannot add a milestone to Alice's project", async ({ asAlice, asBob }) => {
      const project = await createProject(asAlice);

      expectRefused(
        await asBob.post(`/v1/projects/${project.id}/milestone`, {
          data: { name: 'Planted' },
        }),
        'POST /v1/projects/:id/milestone',
      );
    });

    test("Bob cannot edit or delete Alice's milestone", async ({ asAlice, asBob }) => {
      knownHole(PR_35);
      const project = await createProject(asAlice);
      const milestone = await createMilestone(asAlice, project.id);

      expectRefused(
        await asBob.post(`/v1/projects/milestone/${milestone.id}`, {
          data: { name: 'Taken over' },
        }),
        'POST /v1/projects/milestone/:id',
      );
      expectRefused(
        await asBob.delete(`/v1/projects/milestone/${milestone.id}`),
        'DELETE /v1/projects/milestone/:id',
      );
    });
  });

  test.describe('views', () => {
    test("Bob cannot read, edit or delete Alice's view", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      knownHole(VIEWS_OPEN);
      const view = await createView(asAlice, alice);

      expectRefused(await asBob.get(`/v1/views/${view.id}`), 'GET /v1/views/:id');
      expectRefused(
        await asBob.post(`/v1/views/${view.id}`, {
          data: { name: 'Taken over', filters: { priority: { filterType: 'IS', value: ['2'] } } },
        }),
        'POST /v1/views/:id',
      );
      expectRefused(await asBob.delete(`/v1/views/${view.id}`), 'DELETE /v1/views/:id');

      const after = await getView(asAlice, view.id);
      expect(after.name).toBe(view.name);
      expect(after.deleted).toBeNull();
    });
  });
});
