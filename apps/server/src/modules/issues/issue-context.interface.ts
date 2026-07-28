import { IssueRelationType, WorkflowCategoryEnum } from '@vantikhq/types';

export interface ContextUser {
  id: string;
  fullname: string;
}

export interface ContextState {
  id: string;
  name: string;
  category: WorkflowCategoryEnum;
}

export interface ContextTeam {
  id: string;
  identifier: string;
  name: string;
}

export interface ContextLabel {
  id: string;
  name: string;
}

export interface ContextNamedEntity {
  id: string;
  name: string;
}

export interface ContextIssueRef {
  id: string;
  key: string;
  title: string;
  stateCategory?: WorkflowCategoryEnum | null;
}

export interface ContextRelation {
  type: IssueRelationType;
  issue: ContextIssueRef;
}

export interface ContextLinkedIssue {
  id: string;
  url: string;
  title: string | null;
}

export interface ContextComment {
  id: string;
  author: ContextUser | null;
  createdAt: Date;
  updatedAt: Date;
  bodyMarkdown: string;
  replies?: ContextComment[];
}

/**
 * One criterion off the issue's Definition of Done.
 *
 * Carried in the context rather than left to a second request, because a caller
 * that has to know to ask is a caller that will not ask. An agent reading an
 * issue it is about to work has no way to guess that criteria exist, and one
 * working to an invented standard is worse than one working to none — it
 * reports done with confidence.
 */
export interface ContextCriterion {
  id: string;
  body: string;
  completed: boolean;
  completedAt: Date | null;
}

export interface ContextHistoryEntry {
  at: Date;
  actor: string | null;
  change: string;
  from: string | number | null;
  to: string | number | null;
}

export interface IssueContext {
  id: string;
  key: string;
  title: string;
  descriptionMarkdown: string;
  state: ContextState | null;
  assignee: ContextUser | null;
  team: ContextTeam;
  labels: ContextLabel[];
  priority: number | null;
  estimate: number | null;
  dueDate: Date | null;
  project: ContextNamedEntity | null;
  cycle: ContextNamedEntity | null;
  /**
   * What the issue touches, named rather than left as ids.
   *
   * The whole point of this endpoint is that an agent can start from one
   * request. Modules and the capability arrive resolved for the same reason the
   * state and the labels do: an id tells a reader nothing.
   */
  modules: ContextNamedEntity[];
  capability: ContextNamedEntity | null;
  parent: ContextIssueRef | null;
  subIssues: ContextIssueRef[];
  relations: ContextRelation[];
  linkedIssues: ContextLinkedIssue[];
  criteria: ContextCriterion[];
  comments: ContextComment[];
  history: ContextHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `type` on an IssueRelation row is written from the perspective of `issueId`.
 * When the requested issue is on the `relatedIssueId` side the relation has to
 * be flipped so the caller always reads it from its own perspective.
 */
export const inverseRelationType: Record<IssueRelationType, IssueRelationType> =
  {
    [IssueRelationType.BLOCKS]: IssueRelationType.BLOCKED,
    [IssueRelationType.BLOCKED]: IssueRelationType.BLOCKS,
    [IssueRelationType.RELATED]: IssueRelationType.RELATED,
    [IssueRelationType.DUPLICATE]: IssueRelationType.DUPLICATE_OF,
    [IssueRelationType.DUPLICATE_OF]: IssueRelationType.DUPLICATE,
    [IssueRelationType.SIMILAR]: IssueRelationType.SIMILAR,
  };

export const priorityNames: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};
