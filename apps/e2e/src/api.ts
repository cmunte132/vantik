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

export async function getTeam(
  api: APIRequestContext,
  teamId: string,
): Promise<Team> {
  return ok(await api.get(`/v1/teams/${teamId}`), 'reading a team');
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

export async function getView(
  api: APIRequestContext,
  viewId: string,
): Promise<View> {
  return ok(await api.get(`/v1/views/${viewId}`), 'reading a view');
}
