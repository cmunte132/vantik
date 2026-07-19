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
  parent: ContextIssueRef | null;
  subIssues: ContextIssueRef[];
  relations: ContextRelation[];
  linkedIssues: ContextLinkedIssue[];
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
