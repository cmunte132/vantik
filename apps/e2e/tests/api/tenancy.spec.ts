import type { APIResponse } from '@playwright/test';

import {
  commentsOn,
  createComment,
  createIssue,
  createLabel,
  createMilestone,
  createProject,
  createSpareTeam,
  createView,
  currentView,
  getIssue,
  issuesOf,
  labelsOf,
  projects,
  stateNamed,
  teamsOf,
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
 *
 * Call it after the test's own setup, never before. An inverted test passes
 * whatever makes it fail, so setup that broke underneath it would read as the
 * hole still being open. Once setup has run and been checked, the only thing
 * left to fail is Bob's attempt.
 */
function knownHole(fixedBy: string) {
  test.fail(true, `Known hole on main, closed by ${fixedBy}`);
}

const VIEWS_OPEN = 'nothing yet: the view routes take an id and never check its workspace';

test.describe('the workspace boundary', () => {
  test("Bob's own credentials work, so a refusal below is about Alice's records", async ({
    asBob,
    bob,
  }) => {
    const issue = await createIssue(asBob, bob);
    expect((await asBob.get(`/v1/issues/${issue.id}`)).status()).toBe(200);
    expect((await asBob.get(`/v1/teams/${bob.teamId}/members`)).status()).toBe(200);
  });

  test.describe('issues', () => {
    test("Bob cannot read Alice's issue or anything hanging off it", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      const issue = await createIssue(asAlice, alice);

      for (const suffix of ['', '/context']) {
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

      const titles = (await issuesOf(asAlice)).map((i) => i.title);
      expect(titles).not.toContain(title);
    });

    test("Bob cannot list Alice's issues by naming her workspace", async ({
      asBob,
      alice,
    }) => {
      // Naming a workspace you are not a member of is refused outright.
      const response = await asBob.post('/v1/issues/filter', {
        data: { filters: {}, workspaceId: alice.workspaceId },
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

    test("Bob cannot edit or delete Alice's comment", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      const issue = await createIssue(asAlice, alice);
      const text = unique('Original');
      const comment = await createComment(asAlice, issue.id, text);

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

      const comments = await commentsOn(asAlice, issue.id);
      expect(comments.find((c) => c.id === comment.id)?.bodyMarkdown).toContain(
        text,
      );
    });
  });

  test.describe('teams', () => {
    test("Bob cannot see Alice's team or its members", async ({
      asBob,
      alice,
    }) => {
      expect((await teamsOf(asBob)).map((t) => t.id)).not.toContain(alice.teamId);
      expectRefused(
        await asBob.get(`/v1/teams/${alice.teamId}/members`),
        'GET /v1/teams/:id/members',
      );
    });

    test("Bob cannot rename Alice's team", async ({ asAlice, asBob }) => {
      const team = await createSpareTeam(asAlice);
      const nameOf = async () =>
        (await teamsOf(asAlice)).find((t) => t.id === team.id)?.name;
      expect(await nameOf()).toBe(team.name);

      expectRefused(
        await asBob.post(`/v1/teams/${team.id}`, { data: { name: 'Taken over' } }),
        'POST /v1/teams/:id',
      );
      expect(await nameOf()).toBe(team.name);
    });

    test("Bob cannot delete Alice's team", async ({ asAlice, asBob }) => {
      const team = await createSpareTeam(asAlice);
      const aliceSees = async () => (await teamsOf(asAlice)).map((t) => t.id);
      expect(await aliceSees()).toContain(team.id);

      expectRefused(await asBob.delete(`/v1/teams/${team.id}`), 'DELETE /v1/teams/:id');
      expect(await aliceSees()).toContain(team.id);
    });
  });

  test.describe('workflow states', () => {
    test("Bob cannot list Alice's team's states", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      expect((await workflows(asAlice, alice.teamId)).length).toBeGreaterThan(0);

      expectRefused(
        await asBob.get(`/v1/${alice.teamId}/workflows`),
        'GET /v1/:teamId/workflows',
      );
    });

    test("Bob cannot rename one of Alice's states", async ({ asAlice, asBob }) => {
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
    test("Bob cannot rename or delete Alice's label", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      const label = await createLabel(asAlice, alice);
      const listed = await labelsOf(asAlice, alice);
      expect(listed.find((l) => l.id === label.id)?.name).toBe(label.name);

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
      const label = await createLabel(asAlice, alice);
      const own = (await labelsOf(asAlice, alice)).map((l) => l.id);
      expect(own).toContain(label.id);

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
      const name = unique('Planted label');
      // Alice's listing works, so its answer below means something.
      expect((await labelsOf(asAlice, alice)).length).toBeGreaterThan(0);

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
      const project = await createProject(asAlice);
      const milestone = await createMilestone(asAlice, project.id);
      expect(milestone.id).toBeTruthy();

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
    test("Bob cannot edit or delete Alice's view", async ({
      asAlice,
      asBob,
      alice,
    }) => {
      const view = await createView(asAlice, alice);
      expect((await currentView(asAlice, view)).name).toBe(view.name);
      knownHole(VIEWS_OPEN);

      expectRefused(
        await asBob.post(`/v1/views/${view.id}`, {
          data: { name: 'Taken over', filters: { priority: { filterType: 'IS', value: ['2'] } } },
        }),
        'POST /v1/views/:id',
      );
      expectRefused(await asBob.delete(`/v1/views/${view.id}`), 'DELETE /v1/views/:id');

      const after = await currentView(asAlice, view);
      expect(after.name).toBe(view.name);
      expect(after.deleted).toBeNull();
    });
  });
});
