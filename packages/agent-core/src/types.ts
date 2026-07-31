/**
 * Types for the agent-facing surface.
 *
 * These are deliberately *not* the server's Prisma/DTO types: everything here
 * is named the way an agent thinks about the work ("task", "note", "state
 * category") and carries resolved names rather than raw ids.
 */

export type WorkflowCategory =
  'TRIAGE' | 'BACKLOG' | 'UNSTARTED' | 'STARTED' | 'COMPLETED' | 'CANCELED';

export type RelationType =
  'BLOCKS' | 'BLOCKED' | 'RELATED' | 'DUPLICATE' | 'DUPLICATE_OF' | 'SIMILAR';

/** Priority as a name; Vantik stores 0-4 with 0 meaning "no priority". */
export type PriorityName = 'none' | 'urgent' | 'high' | 'medium' | 'low';

export const priorityByName: Record<PriorityName, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

export const priorityNames: PriorityName[] = [
  'none',
  'urgent',
  'high',
  'medium',
  'low',
];

export interface Team {
  id: string;
  name: string;
  identifier: string;
  workspaceId: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  category: WorkflowCategory;
  position: number;
  teamId: string;
}

export interface Label {
  id: string;
  name: string;
}

/**
 * A body of work several tasks serve. Lean on purpose: the fields an agent can
 * act on, not every column the API keeps.
 */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string | null;
}

export interface User {
  id: string;
  fullname: string;
  email?: string;
}

/**
 * A thing the company ships. A product holds no code and no issues: it groups
 * the modules, and the issues hang off those.
 */
export interface Product {
  id: string;
  name: string;
  /** A short name, for example "cloud". Unique in the workspace. */
  key: string;
  description: string | null;
  status: string | null;
}

/**
 * Usually one repository, sometimes a path inside one, sometimes one service.
 *
 * A module has exactly one owner — a team or a product, never both. The linked
 * lists name the other teams and products that use it, and a link carries no
 * authority.
 */
export interface Module {
  id: string;
  name: string;
  /** A short name, for example "server". Unique in the workspace. */
  key: string;
  description: string | null;
  status: string | null;
  owner: { kind: 'team' | 'product'; id: string } | null;
  linkedTeamIds: string[];
  linkedProductIds: string[];
  /**
   * Where the code is. Empty `pathPrefixes` means the whole repository; a
   * monorepo becomes several modules on one repository, each with its own
   * prefixes.
   *
   * Absent unless it was asked for: the repositories of a module live behind
   * their own endpoint, so filling this in costs one request per module.
   */
  repos?: Array<{ repository: string; pathPrefixes: string[] }>;
}

/** Something the software does for the people who use it. */
export interface Capability {
  id: string;
  name: string;
  description: string | null;
  /** planned, active, live or deprecated. */
  status: string | null;
  /** The modules that hold the code. Empty means nobody has built it yet. */
  moduleIds: string[];
}

export interface TaskRef {
  id: string;
  key: string;
  title: string;
}

export interface TaskNote {
  id: string;
  author: string | null;
  createdAt: string;
  body: string;
  replies?: TaskNote[];
}

export interface TaskHistoryEntry {
  at: string;
  actor: string | null;
  change: string;
  from: string | null;
  to: string | null;
}

/** The full working context of one task — the payload of `getTask`. */
/** One criterion off a task's Definition of Done. */
export interface TaskCriterion {
  id: string;
  body: string;
  completed: boolean;
}

/**
 * What "done" means for one task, as recorded on the task itself.
 *
 * Travels with the context rather than behind a second call. A caller that has
 * to know criteria exist before it can ask for them will not ask, and will
 * instead infer a standard from the description and report done against that.
 */
export interface DefinitionOfDone {
  completed: number;
  total: number;
  criteria: TaskCriterion[];
}

export interface TaskContext {
  id: string;
  key: string;
  title: string;
  description: string;
  state: { id: string; name: string; category: WorkflowCategory };
  assignee: User | null;
  team: Team;
  labels: Label[];
  priority: PriorityName;
  estimate: number | null;
  dueDate: string | null;
  project: { id: string; name: string } | null;
  cycle: { id: string; name: string } | null;
  /** The modules this task changes, named. Empty when it names none. */
  modules: Array<{ id: string; name: string }>;
  /** The capability this task delivers, named. */
  capability: { id: string; name: string } | null;
  parent: TaskRef | null;
  subTasks: Array<TaskRef & { stateCategory: WorkflowCategory }>;
  relations: Array<{ type: RelationType; task: TaskRef }>;
  links: Array<{ url: string; title: string | null }>;
  definitionOfDone: DefinitionOfDone;
  notes: TaskNote[];
  history: TaskHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Changes to a task's Definition of Done. Every field is optional and they
 * compose, so one call can tick what was finished and add what the work turned
 * up.
 */
export interface UpdateCriteriaInput {
  /** Criterion ids to mark done. */
  tick?: string[];
  /** Criterion ids to put back to open. */
  untick?: string[];
  /** New criteria, appended after the existing ones. */
  add?: string[];
}

/** A row in a task list — lean on purpose, for filling agent context cheaply. */
export interface TaskListItem {
  id: string;
  key: string;
  title: string;
  state: string;
  stateCategory: WorkflowCategory;
  assigneeId: string | null;
  /** Null for a task belonging to no project. */
  projectId: string | null;
  priority: PriorityName;
  updatedAt: string;
}

/** A search hit, including how the issue was resolved if it was. */
export interface TaskSearchHit {
  id: string;
  key: string;
  title: string;
  description: string;
  stateCategory: WorkflowCategory | '';
  /** First ~500 chars of the comment that explained the fix, when there is one. */
  resolution: string;
  score?: number;
}

/**
 * One agent's attempt at one task, as the agent surface sees it.
 *
 * Lean like the rest of this file: the fields a caller acts on, not every
 * column the run record keeps. The reproducibility fields (config hash, phase
 * timings) are deliberately absent — they exist to compare runs in aggregate,
 * which is a job for the webapp and not for whoever is watching this one.
 */
export interface AgentRunSummary {
  id: string;
  taskId: string;
  status:
    | 'QUEUED'
    | 'CLAIMED'
    | 'RUNNING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'CANCELED'
    | 'EXPIRED'
    | 'NEEDS_REVIEW';
  /** Which backend is running it — `byo`, `hosted`, later others. */
  executor: string;
  attempt: number;
  /** Typed reason a run ended badly; null while it is alive or if it worked. */
  failure: string | null;
  summary: string | null;
  error: string | null;
  /** Branch, and either a PR url or the worktree it was left in. */
  branch: string | null;
  prUrl: string | null;
  worktreePath: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Options for handing a task to an agent. */
export interface DelegateTaskInput {
  /** The agent account to attribute the work to. Optional when there is one. */
  agent?: string;
  /** Executor key. Resolved from the agent and the workspace when omitted. */
  executor?: string;
  /** Repo, branch and the commands that verify a change. */
  repo?: {
    repoUrl?: string;
    repoPath?: string;
    baseBranch?: string;
    delivery?: 'pull_request' | 'worktree';
    setupCommands?: string[];
    testCommand?: string;
    lintCommand?: string;
    typecheckCommand?: string;
    buildCommand?: string;
  };
  /** Start a run even though the task already has one in flight. */
  force?: boolean;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
}
