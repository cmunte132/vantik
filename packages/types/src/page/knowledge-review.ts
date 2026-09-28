import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsUUID,
} from 'class-validator';

import {
  PageEntryKindEnum,
  PageEntryStatusEnum,
  type PageProposal,
} from './page.entity';

/** What triage decided about an entry. */
export enum KnowledgeTriageDecisionEnum {
  AUTO_ACCEPT = 'AUTO_ACCEPT',
  CORROBORATE = 'CORROBORATE',
  ESCALATE = 'ESCALATE',
  REJECT = 'REJECT',
}

/**
 * Why an entry is in front of a person: the reasons triage escalated it
 * with, AUDIT for one it acted on that was drawn to be checked, or the reason
 * the gardener asks a person to archive one.
 */
export enum KnowledgeReviewReasonEnum {
  CONTRADICTS_VERIFIED = 'CONTRADICTS_VERIFIED',
  CONTRADICTS_LOCKED = 'CONTRADICTS_LOCKED',
  UNGROUNDED = 'UNGROUNDED',
  CITATION_FAILED = 'CITATION_FAILED',
  PIN_REQUEST = 'PIN_REQUEST',
  SUPERSEDE_REQUEST = 'SUPERSEDE_REQUEST',
  BROAD_SCOPE = 'BROAD_SCOPE',
  JUDGES_DISAGREE = 'JUDGES_DISAGREE',
  NO_LLM = 'NO_LLM',
  EXTERNAL_INPUT = 'EXTERNAL_INPUT',
  UNKNOWN_SOURCE = 'UNKNOWN_SOURCE',
  HARMFUL_SIGNAL = 'HARMFUL_SIGNAL',
  AUDIT = 'AUDIT',
  LOW_AGREEMENT = 'LOW_AGREEMENT',
  /**
   * The code now contradicts an entry the gardener asks about rather than
   * disputing: a person verified it, its page is locked, or a person put it
   * back after it was last disputed.
   */
  CITATION_CONTRADICTED = 'CITATION_CONTRADICTED',
  /** A change to the code removed a file the entry cites. */
  CITATION_MISSING = 'CITATION_MISSING',
  /** Cited code changed, and no judge could say whether the entry holds. */
  CITATION_UNJUDGED = 'CITATION_UNJUDGED',
  /** A verified entry nobody used or found to hold within the decay window. */
  UNUSED = 'UNUSED',
}

/** What a person did with an entry triage had decided about. */
export enum KnowledgeVerdictEnum {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  EDITED = 'EDITED',
}

export type KnowledgeAutoTriage = 'off' | 'shadow' | 'on';

/** The entry a review item is about, as much of it as judging it needs. */
export interface KnowledgeReviewEntry {
  id: string;
  pageId: string;
  content: string;
  scope: string | null;
  kind: PageEntryKindEnum;
  status: PageEntryStatusEnum;
  sourceUserId: string | null;
  createdAt: string | Date;
}

/** One entry waiting on a person, and why. */
export interface KnowledgeReviewItem {
  entry: KnowledgeReviewEntry;
  /** The triage decision it waits on, or null when triage has not decided about it. */
  decisionId: string | null;
  decision: KnowledgeTriageDecisionEnum | null;
  mode: 'SHADOW' | 'ON' | null;
  /** Empty for an entry waiting with no reason given. */
  reasons: KnowledgeReviewReasonEnum[];
  /** Drawn for audit: triage acted on it, and a person checks whether it was right. */
  audit: boolean;
  /** The policy a rejection broke. */
  policy: string | null;
  /** The decision it reached, when its type was backed off. */
  backedOffFrom: KnowledgeTriageDecisionEnum | null;
  /**
   * For an entry the gardener asks a person to archive, the proposal: the
   * reasons then hold the one reason it gives, and the decision fields are
   * null.
   */
  proposal?: KnowledgeReviewProposal | null;
}

/** What the gardener asks a person to do with an entry, and on what. */
export interface KnowledgeReviewProposal {
  id: string;
  /** Said as a reviewer would read it: the file, the commit, the judge's reason. */
  summary: string;
  /** The correction issue opened with it, if one was. */
  issueId: string | null;
  createdAt: string | Date;
}

export interface KnowledgeReviewQueue {
  autoTriage: KnowledgeAutoTriage;
  /** The queue, narrowed to the reasons asked for. */
  items: KnowledgeReviewItem[];
  /** How many items carry each reason, over the whole queue. */
  reasons: Array<{ reason: KnowledgeReviewReasonEnum; count: number }>;
  /**
   * Proposed consolidations of pages people write, waiting on a person to
   * accept or decline, newest first. Not narrowed by reason: they are about
   * a page body, not an entry.
   */
  pageProposals: PageProposal[];
}

/**
 * Reads `?reason=UNGROUNDED`, `?reason=UNGROUNDED,AUDIT` and repeated
 * `?reason=` params alike, dropping anything that is not a reason.
 */
export function parseReviewReasons(
  value: unknown,
): KnowledgeReviewReasonEnum[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const known = new Set<string>(Object.values(KnowledgeReviewReasonEnum));
  const reasons = (Array.isArray(value) ? value : [value])
    .flatMap((part) => String(part).split(','))
    .map((part) => part.trim())
    .filter((part) => known.has(part)) as KnowledgeReviewReasonEnum[];

  return reasons.length ? reasons : undefined;
}

export class KnowledgeReviewQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsUUID()
  pageId?: string;

  /** One reason, a comma-separated list, or the param repeated. */
  @IsOptional()
  @Transform(({ value }) => parseReviewReasons(value) ?? [])
  @IsArray()
  @IsEnum(KnowledgeReviewReasonEnum, { each: true })
  reason?: KnowledgeReviewReasonEnum[];
}

/** A person's answer to an audit: was triage right to do what it did? */
export class ResolveAuditDto {
  @IsBoolean()
  agree: boolean;
}

/**
 * A person's answer to a proposal to archive an entry: archive it, or keep
 * it as it is.
 */
export class ResolveProposalDto {
  @IsBoolean()
  accept: boolean;
}

/** Cells of the table one decision type is measured on. */
export interface KnowledgeAgreementCells {
  both: number;
  triageOnly: number;
  personOnly: number;
  neither: number;
}

/** Agreement between triage and people on one decision type. */
export interface KnowledgeTypeAgreement {
  decision: KnowledgeTriageDecisionEnum;
  /** Null when undefined: no verdicts, or one same answer throughout. */
  kappa: number | null;
  /**
   * Verdicts about this type: where triage decided it, or the verdict says
   * it should have. The minimum is counted over these.
   */
  samples: number;
  observed: number | null;
  expected: number | null;
  /** Verdicts in each cell. */
  counts: KnowledgeAgreementCells;
  /** The same, each audited decision standing for those it was drawn from. */
  weighted: KnowledgeAgreementCells;
  /**
   * Whether a person decides these instead of triage, for now. Always false
   * for ESCALATE, which is measured but already waits on a person.
   */
  backedOff: boolean;
  changedAt: string | Date | null;
}

export interface KnowledgeAgreementReport {
  autoTriage: KnowledgeAutoTriage;
  windowDays: number;
  since: string | Date;
  kappaFloor: number;
  kappaMinSamples: number;
  auditRate: number;
  types: KnowledgeTypeAgreement[];
}
