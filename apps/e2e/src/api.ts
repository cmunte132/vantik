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

export async function ok<T>(response: APIResponse, what: string): Promise<T> {
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
  assigneeId: string | null;
  cycleId: string | null;
  projectId: string | null;
  priority: number | null;
  labelIds: string[];
  parentId: string | null;
  description: string | null;
  descriptionMarkdown: string;
  deleted: string | null;
}

/**
 * An issue in the account's team, or in `fields.teamId`. It starts in that
 * team's "Todo" state unless `fields.stateId` names another.
 */
export async function createIssue(
  api: APIRequestContext,
  account: Account,
  fields: Partial<{
    title: string;
    descriptionMarkdown: string;
    stateId: string;
    teamId: string;
    assigneeId: string;
    cycleId: string;
    priority: number;
    labelIds: string[];
  }> = {},
): Promise<Issue> {
  const teamId = fields.teamId ?? account.teamId;
  const stateId = fields.stateId ?? (await stateNamed(api, teamId, 'Todo')).id;

  return ok(
    await api.post('/v1/issues', {
      data: {
        title: unique('Issue'),
        ...fields,
        teamId,
        stateId,
      },
    }),
    'creating an issue',
  );
}

export async function updateIssue(
  api: APIRequestContext,
  issue: Issue,
  fields: Partial<{
    title: string;
    stateId: string;
    assigneeId: string | null;
    priority: number;
  }>,
): Promise<Issue> {
  return ok(
    await api.post(`/v1/issues/${issue.id}`, {
      params: { teamId: issue.teamId },
      data: fields,
    }),
    'updating an issue',
  );
}

/** Moves an issue to another team in the same workspace. */
export async function moveIssue(
  api: APIRequestContext,
  issue: Issue,
  teamId: string,
): Promise<Issue> {
  return ok(
    await api.post(`/v1/issues/${issue.id}/move`, { data: { teamId } }),
    'moving an issue',
  );
}

export async function deleteIssue(
  api: APIRequestContext,
  issue: Issue,
): Promise<void> {
  const response = await api.delete(`/v1/issues/${issue.id}`, {
    params: { teamId: issue.teamId },
  });
  expect(
    response,
    `deleting an issue failed: ${response.status()} ${await response.text()}`,
  ).toBeOK();
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
  preferences: Record<string, unknown>;
  /** The number of the team's current cycle, if one is running. */
  currentCycle: number | null;
}

/**
 * A second team in the account's workspace, for tests that delete or rename a
 * team, or change its settings, and must not touch the one every other test
 * files its issues into.
 */
export async function createSpareTeam(
  api: APIRequestContext,
  fields: Partial<{ identifier: string; preferences: Record<string, unknown> }> = {},
): Promise<Team> {
  const identifier =
    fields.identifier ??
    `S${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return ok(
    await api.post('/v1/teams', {
      data: { name: unique('Spare team'), ...fields, identifier },
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
  description: string | null;
  teams: string[];
}

/** A project, in no team unless `fields.teams` names some. */
export async function createProject(
  api: APIRequestContext,
  fields: Partial<{ name: string; teams: string[] }> = {},
): Promise<Project> {
  return ok(
    await api.post('/v1/projects', {
      data: { name: unique('Project'), ...fields },
    }),
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

export interface Cycle {
  id: string;
  name: string;
  number: number;
  teamId: string;
  status: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** A week-long cycle starting `startsInDays` from now. */
export async function createCycle(
  api: APIRequestContext,
  teamId: string,
  startsInDays = 0,
): Promise<Cycle> {
  const start = Date.now() + startsInDays * DAY;
  return ok(
    await api.post('/v1/cycles/single', {
      data: {
        teamId,
        name: unique('Cycle'),
        startDate: new Date(start).toISOString(),
        endDate: new Date(start + 7 * DAY).toISOString(),
      },
    }),
    'creating a cycle',
  );
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  preferences: Record<string, unknown> | null;
}

/** Every workspace the caller belongs to. */
export async function workspacesOf(api: APIRequestContext): Promise<Workspace[]> {
  return ok(await api.get('/v1/workspaces'), 'listing workspaces');
}

export interface WikiPage {
  id: string;
  title: string;
  description: string | null;
}

export async function getPage(
  api: APIRequestContext,
  pageId: string,
): Promise<WikiPage> {
  return ok(await api.get(`/v1/pages/${pageId}`), 'reading a page');
}

/** The ids of the issues a search of the account's workspace finds. */
export async function searchIssueIds(
  api: APIRequestContext,
  account: Account,
  query: string,
): Promise<string[]> {
  const found = await ok<Array<{ id: string }>>(
    await api.get('/v1/search', {
      params: { workspaceId: account.workspaceId, query },
    }),
    'searching issues',
  );
  return found.map((issue) => issue.id);
}
