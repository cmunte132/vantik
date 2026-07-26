import { VantikAgent } from './agent';
import { VantikClient } from './client';
import { VantikAmbiguousError, VantikNotFoundError } from './errors';

interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/**
 * Fake API. Routes are matched most-specific-first; every call is recorded so
 * tests can assert on ordering, which is the part that matters for closing.
 */
function makeAgent(
  routes: Record<string, unknown | ((call: RecordedCall) => unknown)>,
) {
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = parsed.pathname.replace(/^\/v1/, '');
    const query = Object.fromEntries(parsed.searchParams.entries());
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const call: RecordedCall = { method, path, query, body };
    calls.push(call);

    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return new Response(JSON.stringify({ message: `no route for ${key}` }), {
        status: 404,
      });
    }

    const route = routes[key];
    const payload = typeof route === 'function' ? route(call) : route;
    return new Response(JSON.stringify(payload), {
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

  return { agent, calls };
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
    id: 'state-progress',
    name: 'In Progress',
    category: 'STARTED',
    position: 1,
    teamId: 'team-eng',
  },
  {
    id: 'state-done',
    name: 'Done',
    category: 'COMPLETED',
    position: 2,
    teamId: 'team-eng',
  },
  {
    id: 'state-shipped',
    name: 'Shipped',
    category: 'COMPLETED',
    position: 3,
    teamId: 'team-eng',
  },
];

const issue42 = {
  id: 'issue-42',
  number: 42,
  title: 'Connection pool exhausted',
  teamId: 'team-eng',
  stateId: 'state-progress',
};

/** The API row carries scheduling and ownership columns the agent never uses. */
const projects = [
  {
    id: 'project-search',
    name: 'Search rewrite',
    description: 'Replace the search stack',
    status: 'In Progress',
    startDate: '2026-01-01',
    leadUserId: 'user-1',
    teams: ['team-eng'],
    workspaceId: 'ws',
  },
];

const baseRoutes = {
  'GET /teams': teams,
  'GET /team-eng/workflows': engStates,
  'GET /issues/number/42': issue42,
};

/** A second team, for the cases where "which team?" must not be asked at all. */
const designTeam = {
  id: 'team-design',
  name: 'Design',
  identifier: 'DES',
  workspaceId: 'ws',
};

const multiTeamRoutes = {
  ...baseRoutes,
  'GET /teams': [...teams, designTeam],
  'GET /team-design/workflows': [] as unknown[],
};

describe('resolving task references', () => {
  it('turns an issue key into the underlying issue', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issues/issue-42': issue42,
    });

    await agent.updateTask('ENG-42', { title: 'Renamed' });

    const update = calls.find((call) => call.method === 'POST');
    expect(update?.path).toBe('/issues/issue-42');
    expect(update?.query.teamId).toBe('team-eng');
  });

  it('is case insensitive about the team identifier', async () => {
    const { agent } = makeAgent({
      ...baseRoutes,
      'POST /issues/issue-42': issue42,
    });

    await expect(
      agent.updateTask('eng-42', { title: 'Renamed' }),
    ).resolves.toMatchObject({ key: 'ENG-42' });
  });

  it('explains itself when the reference is not a key', async () => {
    const { agent } = makeAgent(baseRoutes);

    await expect(agent.getTask('the pool bug')).rejects.toThrow(
      /not a task reference/,
    );
  });

  it('lists the real teams when the identifier is unknown', async () => {
    const { agent } = makeAgent(baseRoutes);

    await expect(agent.getTask('OPS-1')).rejects.toThrow(
      /No team "OPS".*ENG \(Engineering\)/s,
    );
  });
});

describe('closeTask', () => {
  it('posts the resolution before moving to COMPLETED', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issue_comments': { id: 'comment-1', bodyMarkdown: 'Bumped pool' },
      'POST /issues/issue-42': issue42,
    });

    await agent.closeTask('ENG-42', { resolution: 'Bumped pool to 20' });

    const writes = calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.path);
    expect(writes).toEqual(['/issue_comments', '/issues/issue-42']);
  });

  it('moves to the lowest-positioned COMPLETED state', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issues/issue-42': issue42,
    });

    await agent.closeTask('ENG-42');

    const update = calls.find((call) => call.path === '/issues/issue-42');
    expect(update?.body).toEqual({ stateId: 'state-done' });
  });

  it('honours an explicit state name', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issues/issue-42': issue42,
    });

    await agent.closeTask('ENG-42', { state: 'Shipped' });

    const update = calls.find((call) => call.path === '/issues/issue-42');
    expect(update?.body).toEqual({ stateId: 'state-shipped' });
  });

  it('skips the note when there is no resolution to record', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issues/issue-42': issue42,
    });

    await agent.closeTask('ENG-42');

    expect(calls.some((call) => call.path === '/issue_comments')).toBe(false);
  });

  it('reports the Definition of Done as it stood at the close', async () => {
    const { agent } = makeAgent({
      ...baseRoutes,
      'GET /checklist_items': [
        { id: 'item-1', body: 'Pool sized from config', completed: true, sortOrder: 1 },
        { id: 'item-2', body: 'Exhaustion is logged', completed: false, sortOrder: 2 },
      ],
      'POST /issues/issue-42': issue42,
    });

    const closed = await agent.closeTask('ENG-42');

    expect(closed.definitionOfDone).toEqual({
      completed: 1,
      total: 2,
      criteria: [
        { id: 'item-1', body: 'Pool sized from config', completed: true },
        { id: 'item-2', body: 'Exhaustion is logged', completed: false },
      ],
    });
  });

  // A server predating the checklist route 404s it. Closing a task is not a
  // request for criteria, so it must not fail over their absence.
  it('closes against a server that does not serve criteria', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issues/issue-42': issue42,
    });

    const closed = await agent.closeTask('ENG-42');

    expect(closed.definitionOfDone).toEqual({
      completed: 0,
      total: 0,
      criteria: [],
    });
    const update = calls.find((call) => call.path === '/issues/issue-42');
    expect(update?.body).toEqual({ stateId: 'state-done' });
  });
});

describe('pickUpTask', () => {
  it('assigns the caller and starts the task in one write', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'GET /users': { id: 'user-me', fullname: 'Chris' },
      'POST /issues/issue-42': issue42,
    });

    await agent.pickUpTask('ENG-42');

    const update = calls.find((call) => call.path === '/issues/issue-42');
    expect(update?.body).toEqual({
      assigneeId: 'user-me',
      stateId: 'state-progress',
    });
  });
});

describe('createTask', () => {
  it('defaults to the team backlog state and returns the new key', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issues': {
        id: 'issue-99',
        number: 99,
        title: 'New thing',
        teamId: 'team-eng',
        stateId: 'state-backlog',
      },
    });

    const task = await agent.createTask({
      title: 'New thing',
      description: '# Heading',
    });

    const create = calls.find((call) => call.path === '/issues');
    expect(create?.body).toMatchObject({
      teamId: 'team-eng',
      stateId: 'state-backlog',
      descriptionMarkdown: '# Heading',
    });
    expect(task.key).toBe('ENG-99');
  });

  it('rejects unknown labels naming the ones that exist', async () => {
    const { agent } = makeAgent({
      ...baseRoutes,
      'GET /labels': [{ id: 'label-bug', name: 'bug' }],
    });

    await expect(
      agent.createTask({ title: 'x', labels: ['regresion'] }),
    ).rejects.toBeInstanceOf(VantikNotFoundError);
  });

  it('asks which team to use when the workspace has several', async () => {
    const { agent } = makeAgent({
      'GET /teams': [
        ...teams,
        { id: 'team-ops', name: 'Ops', identifier: 'OPS', workspaceId: 'ws' },
      ],
    });

    await expect(agent.createTask({ title: 'x' })).rejects.toBeInstanceOf(
      VantikAmbiguousError,
    );
  });

  it('files into a project named by name', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'GET /projects': projects,
      'POST /issues': { ...issue42, id: 'issue-99', number: 99 },
    });

    await agent.createTask({ title: 'New thing', project: 'Search rewrite' });

    const create = calls.find((call) => call.path === '/issues');
    expect(create?.body).toMatchObject({ projectId: 'project-search' });
  });

  it('names the projects that exist when the one asked for does not', async () => {
    const { agent } = makeAgent({ ...baseRoutes, 'GET /projects': projects });

    await expect(
      agent.createTask({ title: 'x', project: 'Serch rewrite' }),
    ).rejects.toThrow(/No project "Serch rewrite".*Search rewrite/s);
  });
});

describe('projects', () => {
  it('hands back only the fields an agent acts on', async () => {
    const { agent } = makeAgent({ 'GET /projects': projects });

    await expect(agent.listProjects()).resolves.toEqual([
      {
        id: 'project-search',
        name: 'Search rewrite',
        description: 'Replace the search stack',
        status: 'In Progress',
      },
    ]);
  });

  it('resolves a project by name straight after creating it', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'GET /projects': [] as unknown[],
      'POST /projects': {
        id: 'project-new',
        name: 'Billing rework',
        description: null,
        status: 'Backlog',
      },
      'POST /issues': { ...issue42, id: 'issue-99', number: 99 },
    });

    await agent.createProject({ name: 'Billing rework' });
    await agent.createTask({ title: 'First slice', project: 'Billing rework' });

    const create = calls.find((call) => call.path === '/issues');
    expect(create?.body).toMatchObject({ projectId: 'project-new' });
    // Creating seeds the cache, so resolving the name costs no second listing.
    expect(
      calls.filter(
        (call) => call.path === '/projects' && call.method === 'GET',
      ),
    ).toHaveLength(1);
  });

  it('restricts a list to one project', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'GET /projects': projects,
      'POST /issues/filter': { issues: [], page: 1, perPage: 50, total: 0 },
    });

    await agent.listTasks({ project: 'Search rewrite' });

    const filter = calls.find((call) => call.path === '/issues/filter');
    expect(
      (filter?.body as { filters: Record<string, unknown> }).filters,
    ).toMatchObject({
      project: { filterType: 'IS', value: ['project-search'] },
    });
  });
});

describe('listTasks', () => {
  it('expands a state category into that team’s state ids', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issues/filter': { issues: [], page: 1, perPage: 50, total: 0 },
    });

    await agent.listTasks({ team: 'ENG', stateCategory: 'COMPLETED' });

    const filter = calls.find((call) => call.path === '/issues/filter');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((filter?.body as any).filters.status.value).toEqual([
      'state-done',
      'state-shipped',
    ]);
  });

  it('names the state instead of returning its id', async () => {
    const { agent } = makeAgent({
      ...baseRoutes,
      'POST /issues/filter': {
        issues: [
          {
            id: 'issue-42',
            key: 'ENG-42',
            title: 'Pool exhausted',
            stateId: 'state-progress',
            stateCategory: 'STARTED',
            assigneeId: null,
            priority: 2,
            updatedAt: '2026-07-20T00:00:00.000Z',
          },
        ],
        page: 1,
        perPage: 50,
        total: 1,
      },
    });

    const { items } = await agent.listTasks({ team: 'ENG' });

    expect(items[0]).toMatchObject({ state: 'In Progress', priority: 'high' });
  });

  it('asks for lean rows so list output stays cheap', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'POST /issues/filter': { issues: [], page: 1, perPage: 50, total: 0 },
    });

    await agent.listTasks({ team: 'ENG' });

    const filter = calls.find((call) => call.path === '/issues/filter');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((filter?.body as any).view).toBe('list');
  });

  /**
   * "What am I working on?" is workspace-wide and needs no team. Routing the
   * assignee through resolveTeam() made a multi-team workspace demand one.
   */
  it('resolves "me" with no team named, however many teams there are', async () => {
    const { agent, calls } = makeAgent({
      ...multiTeamRoutes,
      'GET /users': { id: 'user-me', fullname: 'Me' },
      'POST /issues/filter': { issues: [], page: 1, perPage: 50, total: 0 },
    });

    await agent.listTasks({ assignee: 'me' });

    const filter = calls.find((call) => call.path === '/issues/filter');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((filter?.body as any).filters.assignee.value).toEqual(['user-me']);
  });

  it('finds a member by email across teams when none is named', async () => {
    const { agent, calls } = makeAgent({
      ...multiTeamRoutes,
      'GET /teams/team-eng/members': [
        { id: 'user-eng', fullname: 'Ada', email: 'ada@example.com' },
      ],
      'GET /teams/team-design/members': [
        { id: 'user-design', fullname: 'Bo', email: 'bo@example.com' },
      ],
      'POST /issues/filter': { issues: [], page: 1, perPage: 50, total: 0 },
    });

    await agent.listTasks({ assignee: 'bo@example.com' });

    const filter = calls.find((call) => call.path === '/issues/filter');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((filter?.body as any).filters.assignee.value).toEqual([
      'user-design',
    ]);
  });

  /**
   * The member cache was keyed on nothing, so the second team's lookup was
   * answered with the first team's members.
   */
  it('does not answer one team’s member lookup with another’s', async () => {
    const { agent } = makeAgent({
      ...multiTeamRoutes,
      'GET /teams/team-eng/members': [
        { id: 'user-eng', fullname: 'Ada', email: 'ada@example.com' },
      ],
      'GET /teams/team-design/members': [
        { id: 'user-design', fullname: 'Bo', email: 'bo@example.com' },
      ],
      'POST /issues/filter': { issues: [], page: 1, perPage: 50, total: 0 },
    });

    await agent.listTasks({ team: 'ENG', assignee: 'ada@example.com' });

    await expect(
      agent.listTasks({ team: 'DES', assignee: 'ada@example.com' }),
    ).rejects.toThrow(/No workspace member "ada@example.com"/);
  });

  /**
   * `GET /labels` filters on `workspaceId OR teamId` and Prisma drops an
   * undefined side, so asking without a workspace matches every label on the
   * server — and a name could resolve to another workspace's label id.
   */
  it('always names a workspace when resolving labels', async () => {
    const { agent, calls } = makeAgent({
      ...baseRoutes,
      'GET /labels': [{ id: 'label-bug', name: 'bug' }],
      'POST /issues/filter': { issues: [], page: 1, perPage: 50, total: 0 },
    });

    await agent.listTasks({ labels: ['bug'] });

    const labels = calls.find((call) => call.path === '/labels');
    expect(labels?.query.workspaceId).toBe('ws');
  });
});

describe('searchTasks', () => {
  it('passes the category filter through and surfaces the resolution', async () => {
    const { agent, calls } = makeAgent({
      'GET /search': [
        {
          id: 'issue-42',
          issueNumber: 'ENG-42',
          title: 'Connection pool exhausted',
          descriptionString: 'pool',
          stateCategory: 'COMPLETED',
          resolutionSnippet: 'Bumped the pool size to 20',
        },
      ],
    });

    const hits = await agent.searchTasks({
      query: 'pg pool',
      stateCategory: 'COMPLETED',
    });

    expect(calls[0].query).toMatchObject({
      query: 'pg pool',
      stateCategory: 'COMPLETED',
    });
    expect(hits[0]).toMatchObject({
      key: 'ENG-42',
      resolution: 'Bumped the pool size to 20',
    });
  });
});

describe('client errors', () => {
  it('refuses to start without a token', () => {
    expect(() => new VantikClient({ token: '', baseUrl: 'http://x' })).toThrow(
      /VANTIK_TOKEN/,
    );
  });

  /**
   * A 403 is the server saying this particular call is not allowed — an agent
   * reaching past its scopes, most often — and it says which one in the body.
   * Reporting it as a bad token threw that away and told the caller, usually a
   * model, to mint a new one, which cannot fix a scope it was never granted.
   */
  it('passes a 403 through with the reason the server gave', async () => {
    const client = new VantikClient({
      baseUrl: 'http://vantik.test',
      token: 'tg_pat_test',
      fetch: (async () =>
        new Response(
          JSON.stringify({ message: 'This agent does not have the delete' }),
          { status: 403 },
        )) as unknown as typeof globalThis.fetch,
    });

    await expect(client.get('/issues')).rejects.toThrow(
      /403.*does not have the delete/,
    );
  });
});
