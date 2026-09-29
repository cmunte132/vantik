import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** What started a gardener job. */
export enum KnowledgeJobTriggerEnum {
  SCHEDULE = 'SCHEDULE',
  EVENT = 'EVENT',
  BOOT = 'BOOT',
}

/** Why a context pack did not give an entry it considered. */
export enum KnowledgePackDropEnum {
  /** Not standing or consolidated when the pack was built. */
  NOT_LIVE = 'NOT_LIVE',
  /** Nothing checked supports it: its trust is too low to give unasked. */
  NOT_TRUSTED = 'NOT_TRUSTED',
  /** Kept, but ranked below the number of entries a pack gives. */
  TOP_K = 'TOP_K',
  /** Did not fit in what was left of the token budget. */
  BUDGET = 'BUDGET',
}

/** Where a pack found an entry it considered. */
export type KnowledgePackSource = 'CONVENTION' | 'SEARCH';

/** How near an entry is to the work a pack was built for. */
export type KnowledgePackNearness = 'SEED' | 'NEIGHBOUR' | 'NONE';

/** One entry a context pack considered. */
export interface KnowledgePackCandidate {
  entryId: string;
  source: KnowledgePackSource;
  /** Its place in the search results, from 1. Null for a convention. */
  searchRank: number | null;
  nearness: KnowledgePackNearness;
  /** Its trust when the pack was built, when it was read. */
  trust: string | null;
  tokens: number | null;
  given: boolean;
  /** Its place in the pack, from 1, when given. */
  order: number | null;
  dropped: KnowledgePackDropEnum | null;
}

export class KnowledgeRecordsQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsUUID()
  entryId?: string;

  @IsOptional()
  @IsUUID()
  agentRunId?: string;

  @IsOptional()
  @IsDateString()
  since?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class KnowledgeMapQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /** The graph as it stood at the end of this day. Today when absent. */
  @IsOptional()
  @IsDateString()
  asOf?: string;
}

export const KNOWLEDGE_MAP_LAYOUTS = ['module', 'page', 'product'] as const;

export type KnowledgeMapLayout = (typeof KNOWLEDGE_MAP_LAYOUTS)[number];

/** A relation the gardener found between two entries. */
export interface KnowledgeRelationRecord {
  id: string;
  createdAt: string | Date;
  fromId: string;
  toId: string;
  type: string;
  decidedBy: string;
  similarity: number | null;
  reason: string | null;
}

/** An entry given to a reader. */
export interface KnowledgeUseRecord {
  id: string;
  createdAt: string | Date;
  entryId: string;
  agentRunId: string | null;
  userId: string | null;
  via: string;
}

/** What a run or its pull request said about an entry it was given. */
export interface KnowledgeSignalRecord {
  id: string;
  createdAt: string | Date;
  entryId: string;
  agentRunId: string;
  source: string;
  kind: string;
  weight: number;
  evidence: string | null;
}

/** Something the gardener did to an entry, or asks a person to do. */
export interface KnowledgeMaintenanceRecord {
  id: string;
  createdAt: string | Date;
  entryId: string;
  action: string;
  reason: string;
  issueId: string | null;
  proposalState: string | null;
  resolvedAt: string | Date | null;
  reversedAt: string | Date | null;
}

/** A decision type stopping or starting again to act alone. */
export interface KnowledgeBackoffRecord {
  id: string;
  createdAt: string | Date;
  decision: string;
  backedOff: boolean;
  kappa: number | null;
  samples: number;
  floor: number;
}

/** One figure on the gardener view, with the line that qualifies it. */
export interface KnowledgeGardenerStat {
  /** Null when there is nothing to measure yet. */
  value: string | null;
  tone: 'good' | 'people' | 'plain' | 'warn';
  note: string;
}

/** Where the facts written in the window are now. */
export interface KnowledgeFactFlow {
  windowDays: number;
  written: number;
  refused: number;
  folded: number;
  settledByAgents: number;
  decidedByPeople: number;
  waiting: number;
  inUse: number;
  givenTimes: number;
  runsWell: number;
  runsWrong: number;
  retired: number;
  retiredContradicted: number;
  retiredUnused: number;
  retiredReplaced: number;
  /** Taken out of use by a person, or by decay with no record of why. */
  retiredOther: number;
}

/** One line of what the gardener did. */
export interface KnowledgeGardenerEvent {
  id: string;
  at: string | Date;
  kind:
    | 'contradicted'
    | 'replaced'
    | 'archived'
    | 'proposed-archive'
    | 'convention'
    | 'backoff'
    | 'resumed'
    | 'escalated';
  title: string;
  detail: string;
  /** The fact it is about, when there is one. */
  entryId: string | null;
  /** The Needs you item, when the gardener sent it there. */
  inboxItemId: string | null;
}

/** One of the gardener's jobs and how it last went. */
export interface KnowledgeGardenerJob {
  job: string;
  lastRunAt: string | Date | null;
  lastError: string | null;
  runsThisWeek: number;
  failedThisWeek: number;
  /** What it did in this workspace this week, as a sentence. */
  outcome: string | null;
}

export interface KnowledgeGardener {
  autoTriage: string;
  settled: KnowledgeGardenerStat;
  agreement: KnowledgeGardenerStat;
  withKnowledge: KnowledgeGardenerStat;
  citations: KnowledgeGardenerStat;
  flow: KnowledgeFactFlow;
  events: KnowledgeGardenerEvent[];
  jobs: KnowledgeGardenerJob[];
}

export type KnowledgeMapNodeType =
  'module' | 'fact' | 'page' | 'file' | 'issue' | 'run';

/** Where a fact stood on the day the map shows. */
export type KnowledgeMapFactState =
  | 'code'
  | 'people'
  | 'observed'
  /** In use, with nothing checked that supports it. */
  | 'unconfirmed'
  | 'needs-you'
  | 'waiting'
  | 'retired';

export interface KnowledgeMapNode {
  id: string;
  type: KnowledgeMapNodeType;
  label: string;
  /** For a fact. */
  state?: KnowledgeMapFactState;
  kind?: string;
  pageId?: string | null;
  moduleIds?: string[];
  /** For a module: its product. For a page: the product it speaks for. */
  productId?: string | null;
  /** For a module, the colour of its product. */
  color?: string | null;
  /** For a run: how it ended. */
  outcome?: 'well' | 'wrong' | null;
  /** For a run and an issue: the issue key. */
  issueKey?: string | null;
}

export type KnowledgeMapEdgeType =
  | 'cites-code'
  | 'cites-issue'
  | 'replaced'
  | 'contradicts'
  | 'refines'
  | 'given'
  | 'part-of';

export interface KnowledgeMapEdge {
  from: string;
  to: string;
  type: KnowledgeMapEdgeType;
}

/** A day on which something changed the graph, for marks on the slider. */
export interface KnowledgeMapMark {
  at: string | Date;
  type: 'replaced' | 'retired' | 'contradicts';
}

export interface KnowledgeMapProduct {
  id: string;
  name: string;
  color: string | null;
}

export interface KnowledgeMap {
  asOf: string | Date;
  /** The day the first fact was written: where the slider starts. */
  since: string | Date | null;
  nodes: KnowledgeMapNode[];
  edges: KnowledgeMapEdge[];
  products: KnowledgeMapProduct[];
  marks: KnowledgeMapMark[];
  /** Per module: how often its facts were given, and how those runs went. */
  moduleUse: Array<{
    moduleId: string;
    given: number;
    runs: number;
    well: number;
    wrong: number;
  }>;
  /** Per fact: how many runs it was given to. */
  factUse: Array<{ entryId: string; runs: number }>;
}

/** A fact a pack considered, with what became of it. */
export interface KnowledgeTraceRow extends KnowledgePackCandidate {
  content: string;
  kind: string;
  /** Where it applies: its first module, or its scope. */
  where: string | null;
  checkedAt: string | Date | null;
  /** What the run's outcome said about it. */
  after: 'well' | 'wrong' | null;
}

export interface KnowledgeRunTrace {
  run: {
    id: string;
    issueId: string;
    issueKey: string | null;
    issueTitle: string | null;
    agentName: string | null;
    status: string;
    startedAt: string | Date | null;
    createdAt: string | Date;
    arm: string | null;
  };
  /** Null for a run dispatched before packs were traced. */
  trace: {
    createdAt: string | Date;
    query: string;
    seedModules: Array<{ id: string; name: string }>;
    neighbourModules: Array<{ id: string; name: string }>;
    topK: number | null;
    tokenBudget: number;
    tokensGiven: number;
    searchFailed: boolean;
    rows: KnowledgeTraceRow[];
  } | null;
  /** How the run's work was judged. */
  after: {
    checks: boolean | null;
    review: boolean | null;
    pullRequest: string | null;
  };
  /** Facts it was given that are being checked again after the run. */
  rechecks: Array<{
    entryId: string;
    order: number | null;
    evidence: string | null;
  }>;
  /** The model calls the run caused, grouped by purpose. */
  modelCalls: Array<{ purpose: string; count: number; detail: string }>;
}

/** A run whose pack can be traced, for the picker. */
export interface KnowledgeTracedRun {
  id: string;
  createdAt: string | Date;
  issueKey: string | null;
  issueTitle: string | null;
  arm: string | null;
  given: number;
}
