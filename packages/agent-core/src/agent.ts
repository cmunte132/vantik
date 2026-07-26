import { VantikClient, VantikClientConfig } from './client';
import { Directory, isUuid, parseIssueKey } from './directory';
import {
  VantikAmbiguousError,
  VantikError,
  VantikNotFoundError,
} from './errors';
import {
  ConsolidateInput,
  ContextPack,
  EntryPolicy,
  EntryStatus,
  KnowledgeEntry,
  KnowledgeGap,
  KnowledgeHit,
  KnowledgePage,
  KnowledgePageRef,
  LinkPageInput,
  LoadContextInput,
  PageLink,
  PagesForInput,
  RecallInput,
  RememberInput,
  RememberResult,
  TriageInput,
  WritePageInput,
} from './knowledge';
import {
  DefinitionOfDone,
  Paginated,
  PriorityName,
  Project,
  TaskContext,
  TaskListItem,
  TaskNote,
  TaskRef,
  TaskSearchHit,
  UpdateCriteriaInput,
  WorkflowCategory,
  WorkflowState,
  priorityByName,
  priorityNames,
} from './types';

interface RawChecklistItem {
  id: string;
  body: string;
  completed: boolean;
  sortOrder: number | null;
}

/** Server-side shapes we consume. Kept local so agent-core stays standalone. */
interface RawIssue {
  id: string;
  number: number;
  title: string;
  teamId: string;
  stateId: string;
  descriptionMarkdown?: string;
}

interface RawContext {
  id: string;
  key: string;
  title: string;
  descriptionMarkdown: string;
  state: { id: string; name: string; category: WorkflowCategory } | null;
  assignee: { id: string; fullname: string } | null;
  team: { id: string; identifier: string; name: string };
  labels: Array<{ id: string; name: string }>;
  priority: number | null;
  estimate: number | null;
  dueDate: string | null;
  project: { id: string; name: string } | null;
  cycle: { id: string; name: string } | null;
  parent: { id: string; key: string; title: string } | null;
  subIssues: Array<{
    id: string;
    key: string;
    title: string;
    stateCategory?: WorkflowCategory | null;
  }>;
  relations: Array<{
    type: string;
    issue: { id: string; key: string; title: string };
  }>;
  linkedIssues: Array<{ url: string; title: string | null }>;
  criteria: Array<{ id: string; body: string; completed: boolean }>;
  comments: RawComment[];
  history: Array<{
    at: string;
    actor: string | null;
    change: string;
    from: string | number | null;
    to: string | number | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface RawComment {
  id: string;
  author: { id: string; fullname: string } | null;
  createdAt: string;
  bodyMarkdown: string;
  replies?: RawComment[];
}

interface RawSearchHit {
  id: string;
  issueNumber: string;
  title: string;
  descriptionMarkdown?: string;
  descriptionString?: string;
  stateCategory?: string;
  resolutionSnippet?: string;
  relevanceScore?: number;
}

export interface CreateTaskInput {
  title: string;
  /** Markdown. Converted to the editor's format server-side. */
  description?: string;
  /**
   * The task's Definition of Done, one string per criterion. Each becomes a
   * checklist item that can be ticked off independently, in the order given.
   *
   * Neutral about whether a task needs any — that judgment belongs to the
   * surface talking to the person or the model, not to the client underneath it.
   */
  acceptanceCriteria?: string[];
  /** Team identifier ("ENG"), name or id. Optional in single-team workspaces. */
  team?: string;
  /** State name or category. Defaults to the team's first BACKLOG state. */
  state?: string;
  labels?: string[];
  priority?: PriorityName;
  /** Member email, full name, id, or "me". */
  assignee?: string;
  /** Parent task key or id, to create this as a sub-task. */
  parent?: string;
  /** Project name or id, to file this under a body of work. */
  project?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  state?: string;
  labels?: string[];
  priority?: PriorityName;
  assignee?: string;
  /** Project name or id. Moves the task under that project. */
  project?: string;
}

export interface ListTasksInput {
  team?: string;
  /** Member email, name, id, or "me". */
  assignee?: string;
  stateCategory?: WorkflowCategory | WorkflowCategory[];
  labels?: string[];
  priority?: PriorityName;
  /** Project name or id; restricts the list to that project's tasks. */
  project?: string;
  page?: number;
  perPage?: number;
  orderBy?: 'updatedAt' | 'createdAt' | 'number' | 'priority';
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  /** Free text, e.g. "Backlog" or "In Progress". Defaults server-side. */
  status?: string;
  /** ISO dates, as the API stores them. */
  startDate?: string;
  endDate?: string;
}

export interface SearchTasksInput {
  query: string;
  stateCategory?: WorkflowCategory | WorkflowCategory[];
  limit?: number;
}

export interface CloseTaskInput {
  /** Markdown explaining how it was resolved. Posted as a note before closing. */
  resolution?: string;
  /** Override the state; defaults to the team's first COMPLETED state. */
  state?: string;
}

/**
 * The task-shaped Vantik API used by the CLI and the MCP server.
 *
 * Everything an agent should not have to think about lives here: issue keys
 * instead of uuids, markdown instead of editor JSON, state *categories*
 * instead of per-team state ids, and the comment-then-transition ordering that
 * makes a resolution searchable.
 */
export class VantikAgent {
  private readonly client: VantikClient;
  private readonly directory: Directory;

  constructor(config: VantikClientConfig | VantikClient = {}) {
    this.client =
      config instanceof VantikClient ? config : new VantikClient(config);
    this.directory = new Directory(this.client);
  }

  // ---------------------------------------------------------------- reading

  /** Full working context for one task: description, notes, history, relations. */
  async getTask(reference: string): Promise<TaskContext> {
    const { id } = await this.resolveTask(reference);
    const context = await this.client.get<RawContext>(`/issues/${id}/context`);
    return this.toTaskContext(context);
  }

  async getNotes(reference: string): Promise<TaskNote[]> {
    const { id } = await this.resolveTask(reference);
    const comments = await this.client.get<RawComment[]>(
      `/issues/${id}/comments`,
    );
    return comments.map((comment) => this.toNote(comment));
  }

  async listTasks(
    input: ListTasksInput = {},
  ): Promise<Paginated<TaskListItem>> {
    const team = input.team
      ? await this.directory.resolveTeam(input.team)
      : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: Record<string, any> = {};

    if (input.stateCategory) {
      filters.status = {
        filterType: 'IS',
        value: await this.stateIdsForCategories(input.stateCategory, team?.id),
      };
    }

    if (input.assignee) {
      const user = await this.resolveAssigneeForFilter(
        input.assignee,
        team?.id,
      );
      filters.assignee = { filterType: 'IS', value: [user.id] };
    }

    if (input.labels?.length) {
      filters.label = {
        filterType: 'INCLUDES',
        value: await this.directory.resolveLabels(input.labels),
      };
    }

    if (input.priority) {
      filters.priority = {
        filterType: 'IS',
        value: [String(priorityByName[input.priority])],
      };
    }

    if (input.project) {
      const project = await this.directory.resolveProject(input.project);
      filters.project = { filterType: 'IS', value: [project.id] };
    }

    const response = await this.client.post<{
      issues: Array<{
        id: string;
        key: string;
        title: string;
        stateId: string;
        stateCategory: string | null;
        assigneeId: string | null;
        projectId: string | null;
        priority: number | null;
        updatedAt: string;
      }>;
      page: number;
      perPage: number;
      total: number;
    }>('/issues/filter', {
      body: {
        filters,
        view: 'list',
        page: input.page ?? 1,
        perPage: input.perPage ?? 50,
        orderBy: input.orderBy ?? 'updatedAt',
        ...(team ? { teamId: team.id } : {}),
      },
    });

    // The filter endpoint returns state ids; agents should never have to carry
    // a uuid around, so name them before handing the rows back.
    const stateNames = await this.stateNames(team?.id);

    return {
      items: response.issues.map(
        ({ stateId, stateCategory, projectId, priority, ...issue }) => ({
          ...issue,
          state: stateNames.get(stateId) ?? stateId,
          stateCategory: (stateCategory ?? '') as WorkflowCategory,
          projectId: projectId ?? null,
          priority: this.toPriorityName(priority),
        }),
      ),
      page: response.page,
      perPage: response.perPage,
      total: response.total,
    };
  }

  /**
   * Full-text + semantic search across titles, descriptions **and notes**.
   * Restrict to `COMPLETED` to ask "has this been fixed before?" — hits carry
   * the resolution text when there is one.
   */
  async searchTasks(input: SearchTasksInput): Promise<TaskSearchHit[]> {
    const categories = input.stateCategory
      ? toArray(input.stateCategory).join(',')
      : undefined;

    const hits = await this.client.get<RawSearchHit[]>('/search', {
      query: {
        query: input.query,
        limit: input.limit ?? 10,
        stateCategory: categories,
      },
    });

    return (hits ?? []).map((hit) => this.toSearchHit(hit));
  }

  /** The workspace's projects — the bodies of work tasks can be filed under. */
  listProjects(): Promise<Project[]> {
    return this.directory.getProjects();
  }

  /** Prior work resembling this one, with how each was resolved. */
  async findSimilarTasks(reference: string): Promise<TaskSearchHit[]> {
    const { id } = await this.resolveTask(reference);
    const hits = await this.client.get<RawSearchHit[]>(
      '/search/similar_issues',
      { query: { issueId: id } },
    );
    return (hits ?? []).map((hit) => this.toSearchHit(hit));
  }

  // ---------------------------------------------------------------- writing

  /**
   * Opens a project: the container for a body of work that spans several tasks.
   *
   * Neutral about when one is warranted — that judgment belongs to the surface
   * talking to the person or the model, not to the client underneath it.
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    const created = await this.client.post<Project>('/projects', {
      body: {
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.startDate ? { startDate: input.startDate } : {}),
        ...(input.endDate ? { endDate: input.endDate } : {}),
      },
    });

    const project: Project = {
      id: created.id,
      name: created.name,
      description: created.description ?? null,
      status: created.status ?? null,
    };

    await this.directory.cacheProject(project);

    return project;
  }

  async createTask(input: CreateTaskInput): Promise<TaskRef> {
    const team = await this.directory.resolveTeam(input.team);

    // Only the team has to be known first; the rest are independent lookups, so
    // they go out together rather than one round trip at a time. Over the MCP
    // server each of these is a full loopback request through the guard stack.
    const [state, labelIds, assignee, parent, project] = await Promise.all([
      input.state
        ? this.directory.resolveState(team.id, input.state)
        : this.directory.stateForCategory(team.id, 'BACKLOG'),
      this.directory.resolveLabels(input.labels ?? [], team.workspaceId),
      input.assignee
        ? this.directory.resolveUser(team.id, input.assignee)
        : undefined,
      input.parent ? this.resolveTask(input.parent) : undefined,
      input.project ? this.directory.resolveProject(input.project) : undefined,
    ]);

    const issue = await this.client.post<RawIssue>('/issues', {
      body: {
        teamId: team.id,
        title: input.title,
        stateId: state.id,
        ...(input.description
          ? { descriptionMarkdown: input.description }
          : {}),
        ...(labelIds.length ? { labelIds } : {}),
        ...(assignee ? { assigneeId: assignee.id } : {}),
        ...(input.priority ? { priority: priorityByName[input.priority] } : {}),
        ...(parent ? { parentId: parent.id } : {}),
        ...(project ? { projectId: project.id } : {}),
      },
    });

    await this.addCriteria(issue.id, input.acceptanceCriteria ?? []);

    return {
      id: issue.id,
      key: `${team.identifier}-${issue.number}`,
      title: issue.title,
    };
  }

  /**
   * Adds criteria to a task's Definition of Done as real checklist items, so
   * they show up in the panel, count towards the progress the board reads, and
   * can be ticked off one at a time.
   *
   * Rendering them as markdown in the description instead looked the same on the
   * page and was inert: nothing to tick, nothing to count.
   */
  async addCriteria(issueId: string, criteria: string[]): Promise<void> {
    const bodies = criteria
      .map((criterion) => criterion.trim())
      .filter(Boolean);

    if (bodies.length === 0) {
      return;
    }

    // sortOrder is sent explicitly. Left to the server each item lands at
    // max+1, which is read per request — so posting these together would race
    // and the list would come back in an arbitrary order.
    await Promise.all(
      bodies.map((body, index) =>
        this.client.post('/checklist_items', {
          query: { issueId },
          body: { body, sortOrder: index + 1 },
        }),
      ),
    );
  }

  /**
   * The task's Definition of Done as it stands.
   *
   * Reads the criteria on their own rather than through the context endpoint,
   * which is called on the way into and out of a change where the rest of the
   * context would be dead weight.
   */
  async getDefinitionOfDone(reference: string): Promise<DefinitionOfDone> {
    const { id } = await this.resolveTask(reference);
    return toDefinitionOfDone(await this.criteriaRows(id));
  }

  /**
   * Ticks, unticks and appends criteria in one call, and reports where that
   * leaves the task.
   *
   * Returning the resulting Definition of Done rather than nothing is the
   * point: a caller ticking the last of seventeen wants to know it was the
   * last, and one that has to make a second request to find out mostly will
   * not.
   */
  async updateCriteria(
    reference: string,
    input: UpdateCriteriaInput,
  ): Promise<DefinitionOfDone> {
    const tick = input.tick ?? [];
    const untick = input.untick ?? [];

    const contradictory = tick.filter((id) => untick.includes(id));
    if (contradictory.length) {
      throw new VantikError(
        `Cannot tick and untick the same criteria in one call: ` +
          `${contradictory.join(', ')}. Nothing was changed. Send whichever ` +
          'you meant.',
      );
    }

    const { id } = await this.resolveTask(reference);
    const existing = await this.criteriaRows(id);
    const rowById = new Map(existing.map((row) => [row.id, row]));

    // Checked against *this* task before anything is written, so a criterion id
    // copied from another issue is refused rather than quietly edited there —
    // the routes address a row by id alone.
    const unknown = [...tick, ...untick].filter((each) => !rowById.has(each));
    if (unknown.length) {
      throw new VantikNotFoundError(
        `No criteria on ${reference} with id ${unknown.join(', ')}. Nothing ` +
          'was changed. Call get_task to read the current ids.',
      );
    }

    const setCompleted = (ids: string[], completed: boolean) =>
      ids.map((criterionId) =>
        this.client.post(`/checklist_items/${criterionId}`, {
          body: { completed },
        }),
      );

    await Promise.all([
      ...setCompleted(tick, true),
      ...setCompleted(untick, false),
    ]);

    const added = (input.add ?? [])
      .map((criterion) => criterion.trim())
      .filter(Boolean);

    if (added.length) {
      // Appended after what is already there, and numbered here rather than by
      // the server: left alone each would land at max+1 read per request, so
      // posting them together would race and the list would come back shuffled.
      const highest = existing.reduce(
        (max, row) => Math.max(max, row.sortOrder ?? 0),
        0,
      );

      await Promise.all(
        added.map((body, index) =>
          this.client.post('/checklist_items', {
            query: { issueId: id },
            body: { body, sortOrder: highest + index + 1 },
          }),
        ),
      );
    }

    return toDefinitionOfDone(await this.criteriaRows(id));
  }

  private async criteriaRows(issueId: string): Promise<RawChecklistItem[]> {
    const rows = await this.client.get<RawChecklistItem[]>('/checklist_items', {
      query: { issueId },
    });

    // A server old enough not to serve this answers with something that is not
    // a list. "No criteria" is the honest reading there, and it keeps a caller
    // that only wanted to close a task from failing over a field it never
    // asked about.
    return Array.isArray(rows) ? rows : [];
  }

  async updateTask(
    reference: string,
    input: UpdateTaskInput,
  ): Promise<TaskRef> {
    const task = await this.resolveTask(reference);

    // Independent of one another once the task is known, so resolved together.
    const [state, assignee, labelIds, project] = await Promise.all([
      input.state
        ? this.directory.resolveState(task.teamId, input.state)
        : undefined,
      input.assignee
        ? this.directory.resolveUser(task.teamId, input.assignee)
        : undefined,
      input.labels ? this.directory.resolveLabels(input.labels) : undefined,
      input.project ? this.directory.resolveProject(input.project) : undefined,
    ]);

    await this.client.post<RawIssue>(`/issues/${task.id}`, {
      query: { teamId: task.teamId },
      body: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.description
          ? { descriptionMarkdown: input.description }
          : {}),
        ...(state ? { stateId: state.id } : {}),
        ...(assignee ? { assigneeId: assignee.id } : {}),
        ...(labelIds ? { labelIds } : {}),
        ...(input.priority ? { priority: priorityByName[input.priority] } : {}),
        ...(project ? { projectId: project.id } : {}),
      },
    });

    return task;
  }

  /**
   * Take ownership: assign the task and move it into the team's first STARTED
   * state, so the board reflects that work has begun.
   */
  async pickUpTask(
    reference: string,
    options: { assignee?: string } = {},
  ): Promise<TaskRef> {
    const task = await this.resolveTask(reference);
    const [user, state] = await Promise.all([
      this.directory.resolveUser(task.teamId, options.assignee ?? 'me'),
      this.directory.stateForCategory(task.teamId, 'STARTED'),
    ]);

    await this.client.post<RawIssue>(`/issues/${task.id}`, {
      query: { teamId: task.teamId },
      body: { assigneeId: user.id, stateId: state.id },
    });

    return task;
  }

  /** Post a note (comment) on a task. Markdown in, markdown out. */
  async addNote(reference: string, body: string): Promise<TaskNote> {
    const task = await this.resolveTask(reference);
    return this.postNote(task.id, body);
  }

  /** Note path for callers that already hold a resolved id. */
  private async postNote(issueId: string, body: string): Promise<TaskNote> {
    const comment = await this.client.post<RawComment>('/issue_comments', {
      query: { issueId },
      body: { bodyMarkdown: body },
    });

    return this.toNote(comment);
  }

  /**
   * Close a task, recording how it was resolved.
   *
   * The resolution note is posted *before* the state change on purpose: search
   * treats the last note at or before the transition into COMPLETED as the
   * issue's resolution, which is what makes "how was this fixed last time?"
   * answerable later.
   */
  /**
   * Closes the task and reports what its Definition of Done looked like at the
   * moment it closed.
   *
   * Warn, never block — the same posture the webapp takes when a state change
   * would complete an issue with criteria still open. The close goes through
   * either way; the caller is told, and deciding what that means is the
   * caller's job, not this layer's.
   */
  async closeTask(
    reference: string,
    input: CloseTaskInput = {},
  ): Promise<TaskRef & { definitionOfDone: DefinitionOfDone }> {
    const task = await this.resolveTask(reference);

    if (input.resolution) {
      await this.postNote(task.id, input.resolution);
    }

    const state = input.state
      ? await this.directory.resolveState(task.teamId, input.state)
      : await this.directory.stateForCategory(task.teamId, 'COMPLETED');

    // Read before the state change, so what comes back describes the task as it
    // was closed rather than as it might be a moment later.
    const definitionOfDone = toDefinitionOfDone(
      await this.criteriaRows(task.id),
    );

    await this.client.post<RawIssue>(`/issues/${task.id}`, {
      query: { teamId: task.teamId },
      body: { stateId: state.id },
    });

    return { ...task, definitionOfDone };
  }

  // ------------------------------------------------------- knowledge bank

  /** The workspace's pages, as a flat list with their parents. */
  async listPages(): Promise<
    Array<KnowledgePageRef & { parentId: string | null; entryPolicy: EntryPolicy }>
  > {
    const pages = await this.pageIndex();

    return pages.map((page) => ({
      id: page.id,
      title: page.title,
      parentId: page.parentId ?? null,
      entryPolicy: page.entryPolicy,
    }));
  }

  /** One page: its body as markdown, its place in the tree, its standing facts. */
  async readPage(reference: string): Promise<KnowledgePage> {
    const { id } = await this.resolvePage(reference);

    const [page, entries] = await Promise.all([
      this.client.get<RawPage & { ancestors: KnowledgePageRef[] }>(
        `/pages/${id}`,
      ),
      this.client.get<RawEntry[]>('/page_entries', {
        query: { pageId: id, status: 'STANDING' },
      }),
    ]);

    return {
      id: page.id,
      title: page.title,
      body: page.descriptionMarkdown ?? '',
      parentId: page.parentId ?? null,
      entryPolicy: page.entryPolicy,
      ancestors: page.ancestors ?? [],
      standing: (entries ?? []).map((entry) => toEntry(entry)),
      updatedAt: page.updatedAt,
    };
  }

  /** "What do we know about X." */
  async recallKnowledge(input: RecallInput): Promise<KnowledgeHit[]> {
    const result = await this.client.get<RawKnowledgeResult>(
      '/knowledge/search',
      {
        query: {
          query: input.query,
          scope: input.scope,
          limit: input.limit,
        },
      },
    );

    return (result?.hits ?? []).map(toHit);
  }

  /**
   * "Load what matters before I begin."
   *
   * The half of the loop an agent cannot express as a query, because it does
   * not yet know what it does not know — so it says where it is working and
   * how much context it can afford instead.
   */
  async loadContext(input: LoadContextInput = {}): Promise<ContextPack> {
    const pack = await this.client.post<RawContextPack>('/knowledge/context', {
      body: {
        ...(input.task ? { query: input.task } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
      },
    });

    return {
      items: (pack?.items ?? []).map(toHit),
      estimatedTokens: pack?.estimatedTokens ?? 0,
      tokenBudget: pack?.tokenBudget ?? 0,
      omitted: pack?.omitted ?? 0,
    };
  }

  /**
   * Links a page to a team, project, issue or another page.
   *
   * Neutral about whether a link is warranted — like every other write here,
   * the judgment belongs to the surface talking to the person or the model.
   */
  async linkPage(input: LinkPageInput): Promise<PageLink> {
    const page = await this.resolvePage(input.page);

    return this.client.post<PageLink>(`/pages/${page.id}/links`, {
      body: { entityType: input.entityType, entityId: input.entityId },
    });
  }

  /** What a page is linked to. */
  async pageLinks(page: string): Promise<PageLink[]> {
    const resolved = await this.resolvePage(page);

    return (await this.client.get<PageLink[]>(
      `/pages/${resolved.id}/links`,
    )) ?? [];
  }

  /**
   * The pages that relate to one team, project, issue or page.
   *
   * The direction search cannot serve. An agent given "ENG-57" has a uuid and
   * no vocabulary — it does not know the runbook is called "Deploying the
   * worker pool", so no query it can construct will find it. This is a lookup
   * on an index instead.
   */
  async pagesFor(input: PagesForInput): Promise<KnowledgePageRef[]> {
    const pages = await this.client.get<Array<{ id: string; title: string }>>(
      `/pages/related?entityType=${input.entityType}&entityId=${encodeURIComponent(
        input.entityId,
      )}`,
    );

    return (pages ?? []).map((page) => ({ id: page.id, title: page.title }));
  }

  /**
   * Appends one asserted fact to a page.
   *
   * Searches before it writes. When near matches exist and the caller has
   * neither named an entry to supersede nor confirmed the fact is distinct,
   * nothing is written and the matches come back instead. The round trip is the
   * tax: it costs a spamming caller something and costs a careful one almost
   * nothing.
   */
  async remember(input: RememberInput): Promise<RememberResult> {
    const page = await this.resolvePage(input.page);

    if (!input.supersedes && !input.distinct) {
      const near = await this.client.get<RawKnowledgeHit[]>(
        '/knowledge/similar',
        { query: { pageId: page.id, content: input.content } },
      );

      if (near?.length) {
        return {
          status: 'needs-decision',
          nearMatches: near.map(toHit),
          guidance:
            `"${page.title}" already holds ${near.length} similar ` +
            `${near.length === 1 ? 'entry' : 'entries'}. Either pass ` +
            '`supersedes` with the id of the one this replaces, or pass ' +
            '`distinct: true` to say this is a separate fact. Nothing was ' +
            'written.',
        };
      }
    }

    const entry = await this.client.post<RawEntry>('/page_entries', {
      query: { pageId: page.id },
      body: {
        content: input.content,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.session ? { sourceSession: input.session } : {}),
        ...(input.supersedes ? { supersedesId: input.supersedes } : {}),
      },
    });

    return { status: 'written', entry: toEntry(entry) };
  }

  /**
   * Creates a page, or rewrites the body of one that already exists.
   *
   * Neutral about whether a new page is warranted — that judgment belongs to
   * the surface talking to the person or the model, not to the client
   * underneath it.
   */
  async writePage(input: WritePageInput): Promise<KnowledgePageRef> {
    const existing = await this.findPage(input.title);

    if (existing) {
      const updated = await this.client.post<RawPage>(
        `/pages/${existing.id}`,
        {
          body: {
            ...(input.body !== undefined
              ? { descriptionMarkdown: input.body }
              : {}),
            ...(input.entryPolicy ? { entryPolicy: input.entryPolicy } : {}),
          },
        },
      );

      return { id: updated.id, title: updated.title };
    }

    const parent = input.parent
      ? await this.resolvePage(input.parent)
      : undefined;

    const created = await this.client.post<RawPage>('/pages', {
      body: {
        title: input.title,
        ...(input.body !== undefined
          ? { descriptionMarkdown: input.body }
          : {}),
        ...(parent ? { parentId: parent.id } : {}),
        ...(input.entryPolicy ? { entryPolicy: input.entryPolicy } : {}),
      },
    });

    return { id: created.id, title: created.title };
  }

  /**
   * Folds standing entries into a page body and marks them CONSOLIDATED, so the
   * same fact is not served twice — once as narrative and once as the entry it
   * was written from.
   */
  async consolidate(input: ConsolidateInput): Promise<KnowledgePageRef> {
    const page = await this.resolvePage(input.page);

    const updated = await this.client.post<RawPage>(
      `/pages/${page.id}/consolidate`,
      {
        body: {
          descriptionMarkdown: input.body,
          ...(input.entryIds?.length ? { entryIds: input.entryIds } : {}),
        },
      },
    );

    return { id: updated.id, title: updated.title };
  }

  /** Entries on a page, optionally narrowed to a status. */
  async listEntries(
    reference: string,
    status?: EntryStatus[],
  ): Promise<KnowledgeEntry[]> {
    const page = await this.resolvePage(reference);

    const entries = await this.client.get<RawEntry[]>('/page_entries', {
      query: {
        pageId: page.id,
        ...(status?.length ? { status: status.join(',') } : {}),
      },
    });

    return (entries ?? []).map((entry) => toEntry(entry));
  }

  /**
   * Corrects a fact in place.
   *
   * A correction rather than a new claim: the entry keeps its id, its
   * provenance and its retrieval count, which is what a person editing the
   * wording of something already true is asking for. A fact that has *changed*
   * is a different thing and wants `remember` with `supersedes`.
   */
  async updateEntry(
    entryId: string,
    changes: { content?: string; scope?: string | null },
  ): Promise<KnowledgeEntry> {
    const entry = await this.client.post<RawEntry>(
      `/page_entries/${entryId}`,
      {
        body: {
          ...(changes.content !== undefined
            ? { content: changes.content }
            : {}),
          ...(changes.scope !== undefined ? { scope: changes.scope } : {}),
        },
      },
    );

    return toEntry(entry);
  }

  /** Applies one triage decision to a set of entries. */
  async triageEntries(
    input: TriageInput,
  ): Promise<{ updated: number; skipped: number }> {
    return this.client.post<{ updated: number; skipped: number }>(
      '/page_entries/bulk',
      { body: { entryIds: input.entryIds, status: input.status } },
    );
  }

  /** Questions the bank could not answer — what to document next. */
  async knowledgeGaps(): Promise<KnowledgeGap[]> {
    const gaps = await this.client.get<KnowledgeGap[]>('/knowledge/gaps');
    return gaps ?? [];
  }

  // --------------------------------------------------------------- internals

  /**
   * Accepts a page title or id.
   *
   * Titles are how an agent refers to a page — a uuid in a tool call is a thing
   * a model has to carry between turns, and it will not.
   */
  private async resolvePage(reference: string): Promise<KnowledgePageRef> {
    const pages = await this.pageIndex();
    const found = matchPage(pages, reference);

    if (!found) {
      // Built from the list already in hand. Fetching it again to write the
      // error message was a second copy of every page in the workspace, on the
      // path that had just failed.
      throw new VantikNotFoundError(
        `No page "${reference}". Pages in this workspace: ${
          pages.map((page) => page.title).join(', ') || 'none yet'
        }.`,
      );
    }

    return found;
  }

  private async findPage(
    reference: string,
  ): Promise<KnowledgePageRef | undefined> {
    return matchPage(await this.pageIndex(), reference);
  }

  /**
   * The page list, without the bodies.
   *
   * Everything here resolves titles to ids through this, and a full list hands
   * back every document in the bank — each one converted from the editor's JSON
   * to markdown on the way out — to answer a question about names.
   */
  private async pageIndex(): Promise<RawPage[]> {
    return (
      (await this.client.get<RawPage[]>('/pages', {
        query: { summary: 'true' },
      })) ?? []
    );
  }

  /** Accepts an issue key ("ENG-42") or a raw issue id. */
  private async resolveTask(
    reference: string,
  ): Promise<TaskRef & { teamId: string }> {
    const trimmed = reference.trim();

    if (isUuid(trimmed)) {
      const issue = await this.client.get<
        RawIssue & { team?: { identifier: string } }
      >(`/issues/${trimmed}`);
      return {
        id: issue.id,
        teamId: issue.teamId,
        key: issue.team
          ? `${issue.team.identifier}-${issue.number}`
          : String(issue.number),
        title: issue.title,
      };
    }

    const parsed = parseIssueKey(trimmed);
    if (!parsed) {
      throw new VantikNotFoundError(
        `"${reference}" is not a task reference. Use a key like ENG-42 or a task id.`,
      );
    }

    const team = await this.directory.resolveTeam(parsed.identifier);
    const issue = await this.client.get<RawIssue>(
      `/issues/number/${parsed.number}`,
      { query: { teamId: team.id } },
    );

    if (!issue) {
      throw new VantikNotFoundError(`No task ${trimmed}.`);
    }

    return {
      id: issue.id,
      teamId: team.id,
      key: `${team.identifier}-${issue.number}`,
      title: issue.title,
    };
  }

  /**
   * The user a list filter should match.
   *
   * Filtering is workspace-wide unless a team was named, so this must not insist
   * on one. "me" and a raw id resolve without a team at all; a name or email has
   * to be looked up in a member list, and with no team named every team in the
   * workspace is searched — asking the caller to pick a team just to say whose
   * work to show would be answering a question they did not ask.
   */
  private async resolveAssigneeForFilter(
    assignee: string,
    teamId?: string,
  ): Promise<{ id: string }> {
    if (teamId) {
      return this.directory.resolveUser(teamId, assignee);
    }

    const trimmed = assignee.trim();
    if (trimmed.toLowerCase() === 'me') {
      return this.directory.getCurrentUser();
    }
    if (isUuid(trimmed)) {
      return { id: trimmed };
    }

    const teams = await this.directory.getTeams();
    const failures: Error[] = [];

    for (const candidate of teams) {
      try {
        return await this.directory.resolveUser(candidate.id, assignee);
      } catch (error) {
        failures.push(error as Error);
      }
    }

    throw (
      failures[0] ??
      new VantikNotFoundError(
        `No workspace member "${assignee}"; this token can see no teams to look in.`,
      )
    );
  }

  /**
   * The workflow states of one team, or of every team when none is named — so
   * a workspace-wide "what's in progress?" works. Directory caches per team, so
   * asking twice in one call costs one round trip.
   */
  private async statesFor(teamId?: string): Promise<WorkflowState[]> {
    const teamIds = teamId
      ? [teamId]
      : (await this.directory.getTeams()).map((team) => team.id);

    const perTeam = await Promise.all(
      teamIds.map((id) => this.directory.getWorkflowStates(id)),
    );

    return perTeam.flat();
  }

  /** Expands categories into the concrete state ids the filter endpoint takes. */
  private async stateIdsForCategories(
    categories: WorkflowCategory | WorkflowCategory[],
    teamId?: string,
  ): Promise<string[]> {
    const wanted = new Set(toArray(categories));

    return (await this.statesFor(teamId))
      .filter((state) => wanted.has(state.category))
      .map((state) => state.id);
  }

  /** State id → name, for naming the ids the filter endpoint hands back. */
  private async stateNames(teamId?: string): Promise<Map<string, string>> {
    const states = await this.statesFor(teamId);

    return new Map(states.map((state) => [state.id, state.name] as const));
  }

  private toPriorityName(priority: number | null | undefined): PriorityName {
    return priorityNames[priority ?? 0] ?? 'none';
  }

  private toNote(comment: RawComment): TaskNote {
    return {
      id: comment.id,
      author: comment.author?.fullname ?? null,
      createdAt: comment.createdAt,
      body: comment.bodyMarkdown ?? '',
      ...(comment.replies?.length
        ? { replies: comment.replies.map((reply) => this.toNote(reply)) }
        : {}),
    };
  }

  private toSearchHit(hit: RawSearchHit): TaskSearchHit {
    return {
      id: hit.id,
      key: hit.issueNumber,
      title: hit.title,
      description: hit.descriptionMarkdown ?? hit.descriptionString ?? '',
      stateCategory: (hit.stateCategory ?? '') as WorkflowCategory | '',
      resolution: hit.resolutionSnippet ?? '',
      ...(hit.relevanceScore === undefined
        ? {}
        : { score: hit.relevanceScore }),
    };
  }

  /**
   * The fields destructured below are the ones that differ between the API's
   * shape and the agent's; `rest` is everything the two already agree on.
   */
  private toTaskContext(context: RawContext): TaskContext {
    const {
      descriptionMarkdown,
      state,
      team,
      priority,
      subIssues,
      relations,
      linkedIssues,
      criteria,
      comments,
      history,
      ...rest
    } = context;

    return {
      ...rest,
      description: descriptionMarkdown ?? '',
      state: state ?? {
        id: '',
        name: 'unknown',
        category: 'BACKLOG' as WorkflowCategory,
      },
      // The context endpoint does not name the workspace, and nothing reading a
      // task needs it; the field is here because Team carries it.
      team: { ...team, workspaceId: '' },
      priority: this.toPriorityName(priority),
      subTasks: subIssues.map((subIssue) => ({
        ...subIssue,
        stateCategory: (subIssue.stateCategory ?? '') as WorkflowCategory,
      })),
      relations: relations.map((relation) => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: relation.type as any,
        task: relation.issue,
      })),
      links: linkedIssues,
      // An older server does not send this. An empty Definition of Done reads
      // as "none set", which is the truth there — a missing field would instead
      // make every caller guard, and the ones that forgot would crash.
      definitionOfDone: toDefinitionOfDone(criteria ?? []),
      notes: comments.map((comment) => this.toNote(comment)),
      history: history.map((entry) => ({
        ...entry,
        // The only fields that are not already what TaskHistoryEntry wants:
        // the API reports a numeric priority or estimate as a number.
        from: entry.from === null ? null : String(entry.from),
        to: entry.to === null ? null : String(entry.to),
      })),
    };
  }
}

function toDefinitionOfDone(
  rows: Array<{ id: string; body: string; completed: boolean }>,
): DefinitionOfDone {
  return {
    completed: rows.filter((row) => row.completed).length,
    total: rows.length,
    criteria: rows.map((row) => ({
      id: row.id,
      body: row.body,
      completed: row.completed,
    })),
  };
}

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/** One page out of a list, by id or by title. */
function matchPage(
  pages: RawPage[],
  reference: string,
): KnowledgePageRef | undefined {
  const trimmed = reference.trim();
  const needle = trimmed.toLowerCase();

  const matches = pages.filter(
    (page) => page.id === trimmed || page.title.toLowerCase() === needle,
  );

  if (matches.length > 1) {
    throw new VantikAmbiguousError(
      `"${reference}" matches ${matches.length} pages; use the page id.`,
    );
  }

  return matches[0]
    ? { id: matches[0].id, title: matches[0].title }
    : undefined;
}

/** Server-side knowledge shapes. Kept local so agent-core stays standalone. */
interface RawPage {
  id: string;
  title: string;
  descriptionMarkdown?: string;
  parentId?: string | null;
  entryPolicy: EntryPolicy;
  updatedAt: string;
}

interface RawEntry {
  id: string;
  content: string;
  scope: string | null;
  status: EntryStatus;
  sourceUserId: string | null;
  sourceSession: string | null;
  verifiedAt: string | null;
  retrievalCount: number;
  supersedesId: string | null;
  pageId: string;
  createdAt: string;
}

interface RawKnowledgeHit {
  kind: 'page' | 'entry';
  pageId: string;
  pageTitle: string;
  entryId: string | null;
  content: string;
  scope: string | null;
  verified: boolean;
  retrievalCount: number;
  relevanceScore?: number;
}

interface RawKnowledgeResult {
  hits: RawKnowledgeHit[];
}

interface RawContextPack {
  items: RawKnowledgeHit[];
  estimatedTokens: number;
  tokenBudget: number;
  omitted: number;
}

function toEntry(entry: RawEntry): KnowledgeEntry {
  return {
    id: entry.id,
    content: entry.content,
    scope: entry.scope ?? null,
    status: entry.status,
    sourceUserId: entry.sourceUserId ?? null,
    sourceSession: entry.sourceSession ?? null,
    // A timestamp is provenance the caller has to interpret; whether a human
    // vouched for the claim is the thing it actually weighs.
    verified: Boolean(entry.verifiedAt),
    retrievalCount: entry.retrievalCount ?? 0,
    supersedesId: entry.supersedesId ?? null,
    pageId: entry.pageId,
    createdAt: entry.createdAt,
  };
}

function toHit(hit: RawKnowledgeHit): KnowledgeHit {
  return {
    kind: hit.kind,
    page: { id: hit.pageId, title: hit.pageTitle },
    entryId: hit.entryId ?? null,
    content: hit.content,
    scope: hit.scope ?? null,
    verified: Boolean(hit.verified),
    retrievalCount: hit.retrievalCount ?? 0,
    ...(hit.relevanceScore === undefined ? {} : { score: hit.relevanceScore }),
  };
}
