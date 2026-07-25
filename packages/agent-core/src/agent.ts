import { VantikClient, VantikClientConfig } from './client';
import { Directory, isUuid, parseIssueKey } from './directory';
import { VantikNotFoundError } from './errors';
import {
  Paginated,
  PriorityName,
  Project,
  TaskContext,
  TaskListItem,
  TaskNote,
  TaskRef,
  TaskSearchHit,
  WorkflowCategory,
  WorkflowState,
  priorityByName,
  priorityNames,
} from './types';

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

    const state = input.state
      ? await this.directory.resolveState(team.id, input.state)
      : await this.directory.stateForCategory(team.id, 'BACKLOG');

    const labelIds = await this.directory.resolveLabels(
      input.labels ?? [],
      team.workspaceId,
    );

    const assignee = input.assignee
      ? await this.directory.resolveUser(team.id, input.assignee)
      : undefined;

    const parent = input.parent
      ? await this.resolveTask(input.parent)
      : undefined;

    const project = input.project
      ? await this.directory.resolveProject(input.project)
      : undefined;

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

    return {
      id: issue.id,
      key: `${team.identifier}-${issue.number}`,
      title: issue.title,
    };
  }

  async updateTask(
    reference: string,
    input: UpdateTaskInput,
  ): Promise<TaskRef> {
    const task = await this.resolveTask(reference);

    const state = input.state
      ? await this.directory.resolveState(task.teamId, input.state)
      : undefined;

    const assignee = input.assignee
      ? await this.directory.resolveUser(task.teamId, input.assignee)
      : undefined;

    const labelIds = input.labels
      ? await this.directory.resolveLabels(input.labels)
      : undefined;

    const project = input.project
      ? await this.directory.resolveProject(input.project)
      : undefined;

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
  async closeTask(
    reference: string,
    input: CloseTaskInput = {},
  ): Promise<TaskRef> {
    const task = await this.resolveTask(reference);

    if (input.resolution) {
      await this.postNote(task.id, input.resolution);
    }

    const state = input.state
      ? await this.directory.resolveState(task.teamId, input.state)
      : await this.directory.stateForCategory(task.teamId, 'COMPLETED');

    await this.client.post<RawIssue>(`/issues/${task.id}`, {
      query: { teamId: task.teamId },
      body: { stateId: state.id },
    });

    return task;
  }

  // --------------------------------------------------------------- internals

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

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}
