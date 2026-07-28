import { VantikClient } from './client';
import { VantikAmbiguousError, VantikNotFoundError } from './errors';
import {
  Capability,
  Label,
  Module,
  Product,
  Project,
  Team,
  User,
  WorkflowCategory,
  WorkflowState,
} from './types';

const ISSUE_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Caches the in-flight promise, so concurrent askers share one request.
 *
 * A rejection is evicted. Caching one means a single timeout or 500 is replayed
 * for the life of the instance: every later call re-awaits the same settled
 * promise and re-throws an error about a failure that has long since stopped
 * happening.
 */
function memo<K, V>(cache: Map<K, Promise<V>>, key: K, load: () => Promise<V>) {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const loading = load();
  cache.set(key, loading);
  loading.catch(() => cache.delete(key));
  return loading;
}

/** The same eviction for the caches that hold a single promise, not a map. */
function forget<V>(loading: Promise<V>, clear: () => void): Promise<V> {
  loading.catch(clear);
  return loading;
}

/** The API rows behind the product axis, before they are trimmed for an agent. */
interface RawProduct {
  id: string;
  name: string;
  key: string;
  description?: string | null;
  status?: string | null;
}

interface RawModule extends RawProduct {
  ownerTeamId?: string | null;
  ownerProductId?: string | null;
  linkedTeamIds?: string[];
  linkedProductIds?: string[];
}

interface RawModuleRepo {
  /** "owner/name" on the provider. */
  fullName: string;
  pathPrefixes?: string[];
}

interface RawCapability {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  moduleIds?: string[];
}

/**
 * Resolves one row of the product axis by id or by any of its names, and says
 * what there was to choose from when it cannot.
 *
 * Products, modules and capabilities are resolved the same way and differ only
 * in which fields count as a name, so the message an agent gets back for a typo
 * is written once here rather than three times.
 */
function resolveNamed<T extends { id: string; name: string }>(
  rows: T[],
  reference: string,
  kind: string,
  namesOf: (row: T) => string[],
): T {
  const needle = reference.trim().toLowerCase();
  const matches = rows.filter(
    (row) =>
      row.id === reference ||
      namesOf(row).some((name) => name?.toLowerCase() === needle),
  );

  if (matches.length === 0) {
    throw new VantikNotFoundError(
      `No ${kind} "${reference}". Existing ${kind}s: ${
        rows.map((row) => row.name).join(', ') || 'none yet'
      }.`,
    );
  }
  if (matches.length > 1) {
    throw new VantikAmbiguousError(
      `"${reference}" matches ${matches.length} ${kind}s; use its id.`,
    );
  }

  return matches[0];
}

export function parseIssueKey(
  reference: string,
): { identifier: string; number: number } | null {
  const match = ISSUE_KEY_PATTERN.exec(reference.trim());
  if (!match) {
    return null;
  }
  return { identifier: match[1].toUpperCase(), number: Number(match[2]) };
}

/**
 * Caches the workspace's teams, projects, workflow states, labels and members,
 * and turns the names an agent uses ("ENG", "Done", "bug") into the ids the API
 * wants.
 *
 * The cache lives for the lifetime of the instance. That is the right trade for
 * a CLI invocation or a single MCP session; long-lived processes should call
 * `refresh()` if a team or state is added mid-session.
 */
export class Directory {
  private teams?: Promise<Team[]>;
  private projects?: Promise<Project[]>;
  private products?: Promise<Product[]>;
  private modules?: Promise<Module[]>;
  private capabilities?: Promise<Capability[]>;
  private readonly statesByTeam = new Map<string, Promise<WorkflowState[]>>();
  private readonly labelsByWorkspace = new Map<string, Promise<Label[]>>();
  private readonly membersByTeam = new Map<string, Promise<User[]>>();
  private me?: Promise<User>;

  constructor(private readonly client: VantikClient) {}

  /**
   * Drops everything cached, so a long-lived agent can pick up a team, state,
   * project, label or member added since it started. A CLI invocation or one MCP
   * request never needs this; a process holding an agent across requests does.
   */
  refresh(): void {
    this.teams = undefined;
    this.projects = undefined;
    this.products = undefined;
    this.modules = undefined;
    this.capabilities = undefined;
    this.me = undefined;
    this.statesByTeam.clear();
    this.labelsByWorkspace.clear();
    this.membersByTeam.clear();
  }

  getTeams(): Promise<Team[]> {
    this.teams ??= forget(this.client.get<Team[]>('/teams'), () => {
      this.teams = undefined;
    });
    return this.teams;
  }

  getWorkflowStates(teamId: string): Promise<WorkflowState[]> {
    return memo(this.statesByTeam, teamId, () =>
      this.client.get<WorkflowState[]>(`/${teamId}/workflows`),
    );
  }

  getCurrentUser(): Promise<User> {
    this.me ??= forget(this.client.get<User>('/users'), () => {
      this.me = undefined;
    });
    return this.me;
  }

  /**
   * Resolves a team by identifier ("ENG"), name or id. With no reference, the
   * workspace's only team is used — and if there are several, the agent is told
   * to name one rather than having one picked for it.
   */
  async resolveTeam(reference?: string): Promise<Team> {
    const teams = await this.getTeams();

    if (!reference) {
      if (teams.length === 1) {
        return teams[0];
      }
      throw new VantikAmbiguousError(
        `This workspace has ${teams.length} teams (${teams
          .map((team) => team.identifier)
          .join(', ')}). Say which one to use.`,
      );
    }

    const needle = reference.trim().toLowerCase();
    const matches = teams.filter(
      (team) =>
        team.id === reference ||
        team.identifier.toLowerCase() === needle ||
        team.name.toLowerCase() === needle,
    );

    if (matches.length === 0) {
      throw new VantikNotFoundError(
        `No team "${reference}". Available: ${teams
          .map((team) => `${team.identifier} (${team.name})`)
          .join(', ')}.`,
      );
    }
    if (matches.length > 1) {
      throw new VantikAmbiguousError(
        `"${reference}" matches several teams: ${matches
          .map((team) => team.identifier)
          .join(', ')}.`,
      );
    }

    return matches[0];
  }

  /**
   * The workspace's projects, mapped to the fields an agent acts on. The API
   * row carries scheduling and ownership columns too, which only cost context.
   */
  getProjects(): Promise<Project[]> {
    this.projects ??= forget(
      this.client.get<Project[]>('/projects').then((projects) =>
        projects.map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description ?? null,
          status: project.status ?? null,
        })),
      ),
      () => {
        this.projects = undefined;
      },
    );

    return this.projects;
  }

  /** Keeps a just-created project resolvable by name without a refetch. */
  async cacheProject(project: Project): Promise<void> {
    const known = await this.getProjects();
    this.projects = Promise.resolve([...known, project]);
  }

  /** Resolves a project by name or id, naming the alternatives when it cannot. */
  async resolveProject(reference: string): Promise<Project> {
    const projects = await this.getProjects();
    const needle = reference.trim().toLowerCase();
    const matches = projects.filter(
      (project) =>
        project.id === reference || project.name.toLowerCase() === needle,
    );

    if (matches.length === 0) {
      throw new VantikNotFoundError(
        `No project "${reference}". Existing projects: ${
          projects.map((project) => project.name).join(', ') || 'none yet'
        }. Create it first if this work needs one.`,
      );
    }
    if (matches.length > 1) {
      throw new VantikAmbiguousError(
        `"${reference}" matches ${matches.length} projects; use the project id.`,
      );
    }

    return matches[0];
  }

  /**
   * The workspace's products, modules and capabilities — the second axis, which
   * says what the software is made of rather than who is going to work on it.
   *
   * Cached like the rest of the directory: an agent resolving three module names
   * on one issue should not fetch the list three times.
   */
  getProducts(): Promise<Product[]> {
    this.products ??= forget(
      this.client.get<RawProduct[]>('/products').then((products) =>
        products.map((product) => ({
          id: product.id,
          name: product.name,
          key: product.key,
          description: product.description ?? null,
          status: product.status ?? null,
        })),
      ),
      () => {
        this.products = undefined;
      },
    );

    return this.products;
  }

  getModules(): Promise<Module[]> {
    this.modules ??= forget(
      this.client.get<RawModule[]>('/modules').then((modules) =>
        modules.map((module) => ({
          id: module.id,
          name: module.name,
          key: module.key,
          description: module.description ?? null,
          status: module.status ?? null,
          owner: module.ownerProductId
            ? { kind: 'product' as const, id: module.ownerProductId }
            : module.ownerTeamId
              ? { kind: 'team' as const, id: module.ownerTeamId }
              : null,
          linkedTeamIds: module.linkedTeamIds ?? [],
          linkedProductIds: module.linkedProductIds ?? [],
        })),
      ),
      () => {
        this.modules = undefined;
      },
    );

    return this.modules;
  }

  /**
   * The same modules, each carrying the repositories its code sits in.
   *
   * One request per module, which is why it is not what `getModules` returns.
   * A workspace holds tens of modules rather than thousands, and the question
   * this answers — "which module am I in?" — cannot be answered without them.
   */
  async getModulesWithRepos(): Promise<Module[]> {
    const modules = await this.getModules();

    return Promise.all(
      modules.map(async (module) => ({
        ...module,
        repos: (
          await this.client.get<RawModuleRepo[]>(`/modules/${module.id}/repos`)
        ).map((repo) => ({
          repository: repo.fullName,
          pathPrefixes: repo.pathPrefixes ?? [],
        })),
      })),
    );
  }

  getCapabilities(): Promise<Capability[]> {
    this.capabilities ??= forget(
      this.client.get<RawCapability[]>('/capabilities').then((capabilities) =>
        capabilities.map((capability) => ({
          id: capability.id,
          name: capability.name,
          description: capability.description ?? null,
          status: capability.status ?? null,
          moduleIds: capability.moduleIds ?? [],
        })),
      ),
      () => {
        this.capabilities = undefined;
      },
    );

    return this.capabilities;
  }

  /** Resolves a product by key ("cloud"), name or id. */
  async resolveProduct(reference: string): Promise<Product> {
    return resolveNamed(
      await this.getProducts(),
      reference,
      'product',
      (product) => [product.key, product.name],
    );
  }

  /** Resolves a module by key ("server"), name or id. */
  async resolveModule(reference: string): Promise<Module> {
    return resolveNamed(
      await this.getModules(),
      reference,
      'module',
      (module) => [module.key, module.name],
    );
  }

  /** Resolves a capability by name or id. Capabilities carry no key. */
  async resolveCapability(reference: string): Promise<Capability> {
    return resolveNamed(
      await this.getCapabilities(),
      reference,
      'capability',
      (capability) => [capability.name],
    );
  }

  /** Every module a product owns, plus every module it links to. */
  async modulesForProduct(reference: string): Promise<Module[]> {
    const product = await this.resolveProduct(reference);
    const modules = await this.getModules();

    return modules.filter(
      (module) =>
        module.owner?.kind === 'product' &&
        module.owner.id === product.id,
    ).concat(
      modules.filter(
        (module) =>
          module.owner?.id !== product.id &&
          module.linkedProductIds.includes(product.id),
      ),
    );
  }

  /**
   * Resolves a state by name ("In Progress"), id, or category ("STARTED").
   * Category lookups pick the lowest-positioned state in that category, which
   * is the one a human would have picked from the board.
   */
  async resolveState(
    teamId: string,
    reference: string,
  ): Promise<WorkflowState> {
    const states = await this.getWorkflowStates(teamId);
    const needle = reference.trim().toLowerCase();

    const byId = states.find((state) => state.id === reference);
    if (byId) {
      return byId;
    }

    const byName = states.filter(
      (state) => state.name.toLowerCase() === needle,
    );
    if (byName.length === 1) {
      return byName[0];
    }
    if (byName.length > 1) {
      throw new VantikAmbiguousError(
        `Team has ${byName.length} states named "${reference}"; use the state id.`,
      );
    }

    const category = reference.trim().toUpperCase();
    const byCategory = this.pickStateForCategory(
      states,
      category as WorkflowCategory,
    );
    if (byCategory) {
      return byCategory;
    }

    throw new VantikNotFoundError(
      `No state "${reference}" for this team. Available: ${states
        .map((state) => `${state.name} (${state.category})`)
        .join(', ')}.`,
    );
  }

  /** First state of a category, in board order. */
  async stateForCategory(
    teamId: string,
    category: WorkflowCategory,
  ): Promise<WorkflowState> {
    const states = await this.getWorkflowStates(teamId);
    const state = this.pickStateForCategory(states, category);

    if (!state) {
      throw new VantikNotFoundError(
        `Team has no ${category} workflow state. Add one in team settings, or ` +
          `name a state explicitly. Available: ${states
            .map((candidate) => `${candidate.name} (${candidate.category})`)
            .join(', ')}.`,
      );
    }

    return state;
  }

  private pickStateForCategory(
    states: WorkflowState[],
    category: WorkflowCategory,
  ): WorkflowState | undefined {
    return states
      .filter((state) => state.category === category)
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))[0];
  }

  /**
   * The workspace's labels, cached per workspace.
   *
   * The workspace is required: `GET /labels` builds its filter as
   * `workspaceId OR teamId`, and Prisma drops an undefined side, so asking
   * without one matches every label the server has rather than none. Resolving a
   * name against that list could hand back another workspace's label id.
   */
  getLabels(workspaceId: string): Promise<Label[]> {
    return memo(this.labelsByWorkspace, workspaceId, () =>
      this.client.get<Label[]>('/labels', { query: { workspaceId } }),
    );
  }

  /**
   * The workspace this token works in, taken off any team in it. A personal
   * access token is issued for one workspace, so every team it can see is in
   * that workspace and the first one answers for all of them.
   */
  async getWorkspaceId(): Promise<string> {
    const teams = await this.getTeams();
    const workspaceId = teams[0]?.workspaceId;

    if (!workspaceId) {
      throw new VantikNotFoundError(
        'This token cannot see any team, so there is no workspace to work in. ' +
          'Check that it belongs to a workspace with at least one team.',
      );
    }

    return workspaceId;
  }

  /**
   * Maps label names to ids, reporting every unknown name at once. Falls back to
   * the token's own workspace rather than to no workspace at all, which would
   * search every label on the server.
   */
  async resolveLabels(
    names: string[],
    workspaceId?: string,
  ): Promise<string[]> {
    if (names.length === 0) {
      return [];
    }

    const labels = await this.getLabels(
      workspaceId ?? (await this.getWorkspaceId()),
    );
    const byName = new Map(
      labels.map((label) => [label.name.toLowerCase(), label]),
    );

    const ids: string[] = [];
    const unknown: string[] = [];

    for (const name of names) {
      if (isUuid(name)) {
        ids.push(name);
        continue;
      }
      const label = byName.get(name.trim().toLowerCase());
      if (label) {
        ids.push(label.id);
      } else {
        unknown.push(name);
      }
    }

    if (unknown.length > 0) {
      throw new VantikNotFoundError(
        `Unknown label(s): ${unknown.join(', ')}. Existing labels: ${labels
          .map((label) => label.name)
          .join(', ')}.`,
      );
    }

    return ids;
  }

  /** Cached per team: two teams do not have the same members. */
  getMembers(teamId: string): Promise<User[]> {
    return memo(this.membersByTeam, teamId, () =>
      this.client.get<User[]>(`/teams/${teamId}/members`),
    );
  }

  /**
   * Resolves an assignee by id, email, name, or the literal "me".
   */
  async resolveUser(teamId: string, reference: string): Promise<User> {
    if (reference.trim().toLowerCase() === 'me') {
      return this.getCurrentUser();
    }
    if (isUuid(reference)) {
      return { id: reference, fullname: reference };
    }

    const members = await this.getMembers(teamId);
    const needle = reference.trim().toLowerCase();
    const matches = members.filter(
      (member) =>
        member.email?.toLowerCase() === needle ||
        member.fullname?.toLowerCase() === needle,
    );

    if (matches.length === 0) {
      throw new VantikNotFoundError(
        `No workspace member "${reference}". Members: ${members
          .map((member) => member.fullname ?? member.email)
          .join(', ')}.`,
      );
    }
    if (matches.length > 1) {
      throw new VantikAmbiguousError(
        `"${reference}" matches ${matches.length} members; use their email.`,
      );
    }

    return matches[0];
  }
}
