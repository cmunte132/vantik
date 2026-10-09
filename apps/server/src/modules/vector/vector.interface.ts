import { KnowledgeProof, PageEntryStatusEnum } from '@vantikhq/types';

export const KNOWLEDGE_GROUP_LIMIT = 3;
// How many similar issues a caller gets when it names no limit.
export const SIMILAR_ISSUE_DEFAULT_LIMIT = 10;
// These cosine limits use the local MiniLM model. Hosted models can need different limits.
export const KNOWLEDGE_NEAR_MATCH_DISTANCE = 0.5;
export const SIMILAR_ISSUE_DISTANCE_THRESHOLD = 0.55;
export const RESOLUTION_SNIPPET_LENGTH = 500;

export const SERVED_STATUSES: PageEntryStatusEnum[] = [
  PageEntryStatusEnum.STANDING,
  PageEntryStatusEnum.CONSOLIDATED,
];

export function entryGroup(entry: {
  pageId: string | null;
  scope: string | null;
}): string {
  return entry.pageId ?? `scope:${entry.scope ?? ''}`;
}

export interface AxisFilter {
  moduleIds?: string[];
  capabilityId?: string;
}

export interface IssueSearchHit {
  id: string;
  title: string;
  description: string;
  descriptionMarkdown: string;
  descriptionString: string;
  stateId: string;
  stateCategory: string;
  resolutionSnippet: string;
  teamId: string;
  number: number;
  issueNumber: string;
  workspaceId: string;
  assigneeId: string;
  distance?: number;
  relevanceScore?: number;
}

export interface KnowledgeSearchHit extends KnowledgeProof {
  id: string;
  kind: 'page' | 'entry';
  pageId: string | null;
  pageTitle: string;
  entryId: string | null;
  title: string;
  content: string;
  scope: string | null;
  status: string;
  sourceUserId: string | null;
  verified: boolean;
  retrievalCount: number;
  entryKind?: string | null;
  moduleIds?: string[];
  evidenceFor?: { pageId: string; pageTitle: string } | null;
  distance?: number;
  relevanceScore?: number;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[];
  facets: Record<string, Record<string, number>>;
  found: number;
}
