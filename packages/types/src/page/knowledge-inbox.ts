import type {
  KnowledgeReviewEntry,
  KnowledgeReviewReasonEnum,
  KnowledgeTriageDecisionEnum,
} from './knowledge-review';
import type { PageEntry, PageProposal } from './page.entity';

import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/** What an item of the Needs you inbox asks a person to decide. */
export enum KnowledgeInboxKindEnum {
  /** A waiting fact that contradicts a fact in use. */
  CONTRADICTION = 'CONTRADICTION',
  /** A waiting decision or convention that cites no source. */
  RULE = 'RULE',
  /** Any other waiting fact. */
  FACT = 'FACT',
  /** A decision triage acted on, drawn for a person to check. */
  AUDIT = 'AUDIT',
  /** A fact in use that the gardener asks to stop using. */
  ARCHIVE = 'ARCHIVE',
  /** A rewrite of a page body that the gardener proposed. */
  REWRITE = 'REWRITE',
  /** A question agents asked more than once and could not answer. */
  GAP = 'GAP',
}

export enum KnowledgeInboxEventTypeEnum {
  ASSIGNED = 'ASSIGNED',
  COMMENTED = 'COMMENTED',
  DECIDED = 'DECIDED',
  /** The subject left the queue without a decision in the inbox. */
  SETTLED = 'SETTLED',
}

/** The answers a person can give in the inbox. Each kind takes two. */
export enum KnowledgeInboxChoiceEnum {
  /** FACT, RULE: put it in use. */
  USE = 'USE',
  /** FACT, RULE: keep it on the record, and give it to no agent. */
  SET_ASIDE = 'SET_ASIDE',
  /** CONTRADICTION: use the new fact, and retire the one it contradicts. */
  USE_NEW = 'USE_NEW',
  /** CONTRADICTION: keep the fact in use, and set the new one aside. */
  KEEP_OLD = 'KEEP_OLD',
  /** AUDIT: triage was right. */
  AGREE = 'AGREE',
  /** AUDIT: undo what triage did. */
  UNDO = 'UNDO',
  /** ARCHIVE: stop using the fact. */
  RETIRE = 'RETIRE',
  /** ARCHIVE: keep the fact in use. */
  KEEP = 'KEEP',
  /** REWRITE: accept the new body. */
  ACCEPT = 'ACCEPT',
  /** REWRITE: keep the body as it is. */
  DECLINE = 'DECLINE',
  /** GAP: a person wrote the fact that answers it. */
  ANSWER = 'ANSWER',
}

export const KNOWLEDGE_INBOX_VIEWS = [
  'open',
  'mine',
  'unassigned',
  'done',
] as const;

export type KnowledgeInboxView = (typeof KNOWLEDGE_INBOX_VIEWS)[number];

export interface KnowledgeInboxItem {
  id: string;
  kind: KnowledgeInboxKindEnum;
  subjectId: string;
  /** When the subject started to wait on a person. */
  raisedAt: string | Date;
  /** What raised it: triage escalated it, the gardener proposed it, or agents asked it. */
  raisedBy: 'triage' | 'gardener' | 'agents' | 'an agent';
  assigneeId: string | null;
  doneAt: string | Date | null;
  doneById: string | null;
  /** What was decided, as a phrase: "used it", "kept the old fact". */
  resolution: string | null;

  /** The fact it is about. Null for a REWRITE and a GAP. */
  entry: KnowledgeReviewEntry | null;
  pageId: string | null;
  pageTitle: string | null;
  reasons: KnowledgeReviewReasonEnum[];
  /** For an AUDIT: the decision triage acted on. */
  decision: {
    id: string;
    decision: KnowledgeTriageDecisionEnum;
    policy: string | null;
  } | null;
  /** For an ARCHIVE: what the gardener found. For a REWRITE: the proposal. */
  proposal: { id: string; summary: string } | null;
  /** For a GAP: the question, and how many runs asked it. */
  gap: { query: string; count: number } | null;
}

export interface KnowledgeInboxList {
  items: KnowledgeInboxItem[];
  counts: Record<KnowledgeInboxView, number>;
  /** How many open items each person is on. */
  assignees: Array<{ userId: string; count: number }>;
  /** Facts triage settled without a person in the last seven days. */
  settledByAgents: number;
}

export interface KnowledgeInboxEvent {
  id: string;
  createdAt: string | Date;
  type: KnowledgeInboxEventTypeEnum;
  userId: string | null;
  assigneeId: string | null;
  body: string | null;
}

/** One item, with what a decision about it needs. */
export interface KnowledgeInboxDetail {
  item: KnowledgeInboxItem;
  events: KnowledgeInboxEvent[];
  /** The fact the item is about, with its proof. */
  fact: PageEntry | null;
  /** For a CONTRADICTION: the facts in use that it contradicts, with proof. */
  contradicts: PageEntry[];
  /** For a REWRITE: the proposed body. */
  rewrite: PageProposal | null;
  /** For a waiting fact: what each acceptance check of its last triage said. */
  checks: KnowledgeInboxCheck[];
}

/** What one acceptance check said of a fact, in its own words. */
export interface KnowledgeInboxCheck {
  /** Null when its answer could not be read. */
  verdict: 'accept' | 'escalate' | 'contradicted' | null;
  reason: string | null;
}

export class KnowledgeInboxQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_INBOX_VIEWS)
  view?: KnowledgeInboxView;

  /** The items about this page only. */
  @IsOptional()
  @IsUUID()
  pageId?: string;
}

export class AssignKnowledgeInboxItemDto {
  /** The person to put on it. Null takes everyone off it. */
  @ValidateIf((dto) => dto.assigneeId !== null)
  @IsUUID()
  assigneeId: string | null;
}

export class CommentKnowledgeInboxItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}

export class DecideKnowledgeInboxItemDto {
  @IsEnum(KnowledgeInboxChoiceEnum)
  choice: KnowledgeInboxChoiceEnum;

  /** For ANSWER: the fact, in use, that answers the gap. */
  @IsOptional()
  @IsUUID()
  entryId?: string;
}
