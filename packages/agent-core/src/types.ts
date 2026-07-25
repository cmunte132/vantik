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
  parent: TaskRef | null;
  subTasks: Array<TaskRef & { stateCategory: WorkflowCategory }>;
  relations: Array<{ type: RelationType; task: TaskRef }>;
  links: Array<{ url: string; title: string | null }>;
  notes: TaskNote[];
  history: TaskHistoryEntry[];
  createdAt: string;
  updatedAt: string;
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

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
}
