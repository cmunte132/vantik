import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VantikAgent, VantikClient } from '@vantikhq/agent-core';

import { registerVantikTools } from './mcp.tools';

/**
 * Drives the tools through a real MCP client over an in-memory transport, so
 * the schemas, the wiring and the agent-core calls are all exercised together.
 * The Vantik API itself is faked at the fetch boundary.
 */
async function connect(routes: Record<string, unknown>) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = parsed.pathname.replace(/^\/v1/, '');
    requests.push({
      method,
      path,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });

    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
      });
    }

    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  const agent = new VantikAgent(
    new VantikClient({
      baseUrl: 'http://vantik.test',
      token: 'tg_pat_test',
      fetch: fetchImpl,
    }),
  );

  const server = new McpServer({ name: 'vantik', version: 'test' });
  registerVantikTools(server, agent);

  const client = new Client({ name: 'test-client', version: 'test' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, requests };
}

const teams = [
  { id: 'team-eng', name: 'Engineering', identifier: 'ENG', workspaceId: 'ws' },
];

const engStates = [
  {
    id: 'state-backlog',
    name: 'Backlog',
    category: 'BACKLOG',
    position: 0,
    teamId: 'team-eng',
  },
  {
    id: 'state-done',
    name: 'Done',
    category: 'COMPLETED',
    position: 1,
    teamId: 'team-eng',
  },
];

/** The lookups nearly every tool makes before it can do anything. */
const baseRoutes = {
  'GET /teams': teams,
  'GET /team-eng/workflows': engStates,
  // Acceptance criteria are filed as checklist items after the issue exists, so
  // any test passing them reaches this too.
  'POST /checklist_items': { id: 'item-1' },
};

/** A tool result travels as text; these read it back the way the model would. */
function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

function jsonOf(result: unknown) {
  return JSON.parse(textOf(result));
}

describe('vantik MCP tools', () => {
  it('advertises the task workflow tools with descriptions', async () => {
    const { client } = await connect({});

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      'add_note',
      'close_task',
      'create_project',
      'create_task',
      'find_similar_tasks',
      'get_task',
      'list_projects',
      'list_tasks',
      'pick_up_task',
      'search_tasks',
      'update_task',
    ]);
    expect(tools.every((tool) => (tool.description ?? '').length > 20)).toBe(
      true,
    );
  });

  it('creates a task and reports the new key', async () => {
    const { client, requests } = await connect({
      ...baseRoutes,
      'POST /issues': {
        id: 'issue-99',
        number: 99,
        title: 'Pool exhausted',
        teamId: 'team-eng',
        stateId: 'state-backlog',
      },
      'POST /checklist_items': { id: 'item-1' },
    });

    const result = await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Pool exhausted',
        description:
          'The connection pool is exhausted under load in the checkout path.',
        acceptanceCriteria: [
          'Checkout holds at 200 rps without pool errors',
          'Pool size is configurable',
        ],
      },
    });

    const created = requests.find((request) => request.path === '/issues');
    expect(created?.body).toMatchObject({ stateId: 'state-backlog' });
    // The description is the description. Criteria are not folded into it as
    // markdown, which looked right on the page but could not be ticked.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((created?.body as any).descriptionMarkdown).toBe(
      'The connection pool is exhausted under load in the checkout path.',
    );

    // Each criterion becomes a real checklist item on the Definition of Done,
    // ordered as it was given rather than by whichever write landed first.
    const items = requests.filter(
      (request) => request.path === '/checklist_items',
    );
    expect(items.map((item) => item.body)).toEqual([
      { body: 'Checkout holds at 200 rps without pool errors', sortOrder: 1 },
      { body: 'Pool size is configurable', sortOrder: 2 },
    ]);

    expect(jsonOf(result)).toMatchObject({ key: 'ENG-99' });
  });

  it('rejects a thin issue with guidance instead of filing it', async () => {
    const { client, requests } = await connect({
      ...baseRoutes,
    });

    const result = await client.callTool({
      name: 'create_task',
      arguments: { title: 'fix', description: 'broken' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/thin|done|note/i);
    expect(requests.some((request) => request.path === '/issues')).toBe(false);
  });

  it('files a sub-task without acceptance criteria', async () => {
    const { client, requests } = await connect({
      ...baseRoutes,
      'GET /issues/number/42': {
        id: 'issue-42',
        number: 42,
        title: 'Parent',
        teamId: 'team-eng',
        stateId: 'state-backlog',
      },
      'POST /issues': {
        id: 'issue-100',
        number: 100,
        title: 'A step',
        teamId: 'team-eng',
        stateId: 'state-backlog',
      },
    });

    // No acceptance criteria — allowed because the parent carries the objective.
    const result = await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'A step',
        description: 'One concrete step of the parent objective, in the API.',
        parent: 'ENG-42',
      },
    });

    expect(result.isError).toBeFalsy();
    const created = requests.find((request) => request.path === '/issues');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = created?.body as any;
    expect(body.parentId).toBe('issue-42');
    expect(body.descriptionMarkdown).not.toContain('## Acceptance criteria');
  });

  it('closes a task by writing the resolution before the state change', async () => {
    const { client, requests } = await connect({
      ...baseRoutes,
      'GET /issues/number/42': {
        id: 'issue-42',
        number: 42,
        title: 'Pool exhausted',
        teamId: 'team-eng',
        stateId: 'state-backlog',
      },
      'POST /issue_comments': { id: 'comment-1', bodyMarkdown: 'Bumped pool' },
      'POST /issues/issue-42': { id: 'issue-42', number: 42 },
    });

    await client.callTool({
      name: 'close_task',
      arguments: { task: 'ENG-42', resolution: 'Bumped pool to 20' },
    });

    const writes = requests
      .filter((request) => request.method === 'POST')
      .map((request) => request.path);
    expect(writes).toEqual(['/issue_comments', '/issues/issue-42']);
  });

  it('returns a readable tool error instead of throwing', async () => {
    const { client } = await connect({ 'GET /teams': teams });

    const result = await client.callTool({
      name: 'get_task',
      arguments: { task: 'OPS-1' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No team "OPS"/);
  });

  it('files an issue under a project named by name', async () => {
    const { client, requests } = await connect({
      ...baseRoutes,
      'GET /projects': [
        { id: 'project-search', name: 'Search rewrite', status: 'Backlog' },
      ],
      'POST /issues': {
        id: 'issue-99',
        number: 99,
        title: 'Index the notes',
        teamId: 'team-eng',
        stateId: 'state-backlog',
      },
    });

    const result = await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Index the notes',
        description:
          'Notes are not in the search index, so resolutions are unfindable.',
        acceptanceCriteria: ['Searching a note body returns its issue'],
        project: 'Search rewrite',
      },
    });

    expect(result.isError).toBeFalsy();
    const created = requests.find((request) => request.path === '/issues');
    expect(created?.body).toMatchObject({ projectId: 'project-search' });
  });

  it('lists projects, which take no arguments at all', async () => {
    const { client } = await connect({
      'GET /projects': [
        {
          id: 'project-search',
          name: 'Search rewrite',
          description: 'Replace the search stack',
          status: 'Backlog',
          leadUserId: 'user-1',
          workspaceId: 'ws',
        },
      ],
    });

    const result = await client.callTool({
      name: 'list_projects',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    // Lean rows: the scheduling and ownership columns only cost context.
    expect(jsonOf(result)).toEqual([
      {
        id: 'project-search',
        name: 'Search rewrite',
        description: 'Replace the search stack',
        status: 'Backlog',
      },
    ]);
  });

  it('opens a project for an objective that spans several issues', async () => {
    const { client, requests } = await connect({
      'GET /projects': [],
      'POST /projects': {
        id: 'project-new',
        name: 'Search rewrite',
        description: 'Replace the search stack',
        status: 'Backlog',
      },
    });

    const result = await client.callTool({
      name: 'create_project',
      arguments: {
        name: 'Search rewrite',
        description: 'Replace the search stack',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(requests.some((request) => request.path === '/projects')).toBe(true);
    expect(jsonOf(result)).toMatchObject({
      id: 'project-new',
      name: 'Search rewrite',
    });
  });

  it('tells the model what a project is for, not just what the tool does', async () => {
    const { client } = await connect({});

    const { tools } = await client.listTools();
    const create = tools.find((tool) => tool.name === 'create_task');
    const project = tools.find((tool) => tool.name === 'create_project');

    // The opinion lives here and in the skill, never in agent-core or the CLI.
    expect(create?.description).toMatch(/project/i);
    expect(project?.description).toMatch(/several issues/i);
  });

  it('rejects arguments that do not match the schema', async () => {
    const { client } = await connect({});

    const result = await client.callTool({
      name: 'search_tasks',
      arguments: { query: 'pool', stateCategory: ['NOT_A_CATEGORY'] },
    });

    expect(result.isError).toBe(true);
  });
});
