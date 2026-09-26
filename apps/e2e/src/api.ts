import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

import type { Account } from './auth';

/**
 * Small, deliberately boring builders for the records tests need. Each one
 * asserts its own request succeeded, so a test that fails in setup says so
 * rather than failing later on a confusing assertion.
 */

let sequence = 0;

/** A name no other record in this run has. */
export function unique(prefix: string): string {
  sequence += 1;
  return `${prefix} ${process.pid}-${Date.now().toString(36)}-${sequence}`;
}

async function ok<T>(response: APIResponse, what: string): Promise<T> {
  expect(
    response,
    `${what} failed: ${response.status()} ${await response.text()}`,
  ).toBeOK();
  return (await response.json()) as T;
}

export interface Workflow {
  id: string;
  name: string;
  category: string;
}

export async function workflows(
  api: APIRequestContext,
  teamId: string,
): Promise<Workflow[]> {
  return ok(await api.get(`/v1/${teamId}/workflows`), 'listing workflow states');
}

export async function stateNamed(
  api: APIRequestContext,
  teamId: string,
  name: string,
): Promise<Workflow> {
  const state = (await workflows(api, teamId)).find((w) => w.name === name);
  expect(state, `team ${teamId} has no "${name}" state`).toBeTruthy();
  return state!;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  stateId: string;
  teamId: string;
  description: string | null;
  descriptionMarkdown: string;
  deleted: string | null;
}

export async function createIssue(
  api: APIRequestContext,
  account: Account,
  fields: Partial<{ title: string; descriptionMarkdown: string; stateId: string }> = {},
): Promise<Issue> {
  const stateId =
    fields.stateId ?? (await stateNamed(api, account.teamId, 'Todo')).id;

  return ok(
    await api.post('/v1/issues', {
      data: {
        teamId: account.teamId,
        title: unique('Issue'),
        ...fields,
        stateId,
      },
    }),
    'creating an issue',
  );
}

export async function getIssue(
  api: APIRequestContext,
  issueId: string,
): Promise<Issue> {
  return ok(await api.get(`/v1/issues/${issueId}`), 'reading an issue');
}

/**
 * Every issue the caller can see in their workspace. The filter route is the
 * API's issue listing; it leaves out deleted issues and teams the caller is
 * not in.
 */
export async function issuesOf(api: APIRequestContext): Promise<Issue[]> {
  return ok(
    await api.post('/v1/issues/filter', { data: { filters: {} } }),
    'listing issues',
  );
}

export interface Comment {
  id: string;
  issueId: string;
  body: string;
  bodyMarkdown?: string;
}

export async function createComment(
  api: APIRequestContext,
  issueId: string,
  bodyMarkdown: string,
): Promise<Comment> {
  return ok(
    await api.post('/v1/issue_comments', {
      params: { issueId },
      data: { bodyMarkdown },
    }),
    'creating a comment',
  );
}

/** An issue's comments, read from its context: the API's one view of them. */
export async function commentsOn(
  api: APIRequestContext,
  issueId: string,
): Promise<Array<{ id: string; bodyMarkdown: string }>> {
  const context = await ok<{ comments: Array<{ id: string; bodyMarkdown: string }> }>(
    await api.get(`/v1/issues/${issueId}/context`),
    'reading an issue context',
  );
  return context.comments;
}

export interface Label {
  id: string;
  name: string;
  workspaceId: string;
}

export async function createLabel(
  api: APIRequestContext,
  account: Account,
): Promise<Label> {
  return ok(
    await api.post('/v1/labels', {
      data: {
        name: unique('Label'),
        color: '#5c6ac4',
        workspaceId: account.workspaceId,
      },
    }),
    'creating a label',
  );
}

export async function labelsOf(
  api: APIRequestContext,
  account: Account,
): Promise<Label[]> {
  return ok(
    await api.get('/v1/labels', { params: { workspaceId: account.workspaceId } }),
    'listing labels',
  );
}

export interface Team {
  id: string;
  name: string;
  identifier: string;
  workspaceId: string;
}

/**
 * A second team in the account's workspace, for tests that delete or rename a
 * team and must not touch the one every other test files its issues into.
 */
export async function createSpareTeam(api: APIRequestContext): Promise<Team> {
  const identifier = `S${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return ok(
    await api.post('/v1/teams', {
      data: { name: unique('Spare team'), identifier },
    }),
    'creating a team',
  );
}

/** The teams the caller can see. There is no route that reads one team. */
export async function teamsOf(api: APIRequestContext): Promise<Team[]> {
  return ok(await api.get('/v1/teams'), 'listing teams');
}

export interface Project {
  id: string;
  name: string;
}

export async function createProject(api: APIRequestContext): Promise<Project> {
  return ok(
    await api.post('/v1/projects', { data: { name: unique('Project') } }),
    'creating a project',
  );
}

export async function projects(api: APIRequestContext): Promise<Project[]> {
  return ok(await api.get('/v1/projects'), 'listing projects');
}

export interface Milestone {
  id: string;
  name: string;
}

export async function createMilestone(
  api: APIRequestContext,
  projectId: string,
): Promise<Milestone> {
  return ok(
    await api.post(`/v1/projects/${projectId}/milestone`, {
      data: { name: unique('Milestone') },
    }),
    'creating a milestone',
  );
}

export interface View {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  deleted: string | null;
}

export async function createView(
  api: APIRequestContext,
  account: Account,
): Promise<View> {
  return ok(
    await api.post('/v1/views', {
      data: {
        name: unique('View'),
        teamId: account.teamId,
        filters: { priority: { filterType: 'IS', value: ['1'] } },
      },
    }),
    'creating a view',
  );
}

/**
 * A view as it is stored now. The API has no route that reads a view (the
 * webapp gets them through sync), so this re-saves the view's own filters,
 * which changes nothing, and reads the row the update returns.
 */
export async function currentView(
  api: APIRequestContext,
  view: View,
): Promise<View> {
  return ok(
    await api.post(`/v1/views/${view.id}`, { data: { filters: view.filters } }),
    'reading a view back',
  );
}
