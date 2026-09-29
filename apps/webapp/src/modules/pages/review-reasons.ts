import {
  KnowledgeReviewReasonEnum,
  KnowledgeTriageDecisionEnum,
  type KnowledgeReviewItem,
  type KnowledgeReviewQueue,
} from '@vantikhq/types';

import type { PageEntryType } from 'common/types';

/**
 * Why an entry is in front of you, said as a reviewer would say it. The
 * reason is most of what tells you what to look at: an entry that cites
 * nothing wants its source, one that contradicts a confirmed fact wants the
 * two read side by side.
 */
export const REASON_LABELS: Record<KnowledgeReviewReasonEnum, string> = {
  [KnowledgeReviewReasonEnum.CONTRADICTS_VERIFIED]:
    'Contradicts a confirmed fact',
  [KnowledgeReviewReasonEnum.CONTRADICTS_LOCKED]: 'Contradicts a locked page',
  [KnowledgeReviewReasonEnum.UNGROUNDED]: 'Cites nothing that can be checked',
  [KnowledgeReviewReasonEnum.CITATION_FAILED]: 'A citation does not hold',
  [KnowledgeReviewReasonEnum.PIN_REQUEST]: 'A convention',
  [KnowledgeReviewReasonEnum.SUPERSEDE_REQUEST]: 'Corrects a fact not in use',
  [KnowledgeReviewReasonEnum.BROAD_SCOPE]: 'Applies widely',
  [KnowledgeReviewReasonEnum.JUDGES_DISAGREE]: 'The checks disagreed',
  [KnowledgeReviewReasonEnum.NO_LLM]: 'Could not be checked',
  [KnowledgeReviewReasonEnum.EXTERNAL_INPUT]: 'Rests on outside text',
  [KnowledgeReviewReasonEnum.UNKNOWN_SOURCE]:
    'An agent wrote it, and nothing confirms it',
  [KnowledgeReviewReasonEnum.HARMFUL_SIGNAL]: 'Runs went wrong with it',
  [KnowledgeReviewReasonEnum.AUDIT]: 'Audit',
  [KnowledgeReviewReasonEnum.LOW_AGREEMENT]: 'Triage is holding back',
  [KnowledgeReviewReasonEnum.CITATION_CONTRADICTED]: 'The code now disagrees',
  [KnowledgeReviewReasonEnum.CITATION_MISSING]: 'Its cited file is gone',
  [KnowledgeReviewReasonEnum.CITATION_UNJUDGED]: 'Its cited code changed',
  [KnowledgeReviewReasonEnum.UNUSED]: 'Nobody uses it',
};

/** One row of the queue. */
export interface ReviewRow {
  entry: PageEntryType;
  reasons: KnowledgeReviewReasonEnum[];
  /** For an audit, the decision you are asked to check. */
  audit: {
    decisionId: string;
    decision: KnowledgeTriageDecisionEnum;
    policy: string | null;
  } | null;
  /** For an entry in use the gardener asks you to archive, what it found. */
  proposal?: { id: string; summary: string } | null;
}

/**
 * The queue's rows: every entry waiting, as before, each with the reasons
 * triage gave for holding it back; then the decisions drawn for audit; then
 * the entries in use the gardener asks you to archive.
 *
 * The waiting entries come from the synced store, so the queue stays live;
 * the reasons, audits and proposals from the review endpoint. Until that
 * answers, the rows are exactly the entries waiting, with no reasons and
 * nothing else, which is the queue as it was before triage. Whenever triage
 * is off, the gardener's proposals are added to that and nothing of
 * triage's.
 */
export function reviewRows(
  waiting: PageEntryType[],
  review: KnowledgeReviewQueue | undefined,
  find: (entryId: string, pageId: string | null) => PageEntryType | undefined,
): ReviewRow[] {
  const proposals = (review?.items ?? []).flatMap((item): ReviewRow[] =>
    item.proposal
      ? [
          {
            entry: find(item.entry.id, item.entry.pageId) ?? fromItem(item),
            reasons: item.reasons,
            audit: null,
            proposal: { id: item.proposal.id, summary: item.proposal.summary },
          },
        ]
      : [],
  );

  if (!review || review.autoTriage === 'off') {
    return [
      ...waiting.map((entry): ReviewRow => ({
        entry,
        reasons: [],
        audit: null,
      })),
      ...proposals,
    ];
  }

  const reasons = new Map<string, KnowledgeReviewReasonEnum[]>();
  const audits: KnowledgeReviewItem[] = [];

  for (const item of review.items) {
    if (item.proposal) {
      continue;
    }

    if (item.audit) {
      audits.push(item);
    } else {
      reasons.set(item.entry.id, item.reasons);
    }
  }

  return [
    ...waiting.map((entry): ReviewRow => ({
      entry,
      reasons: reasons.get(entry.id) ?? [],
      audit: null,
    })),
    ...audits.flatMap((item): ReviewRow[] =>
      item.decisionId && item.decision
        ? [
            {
              entry: find(item.entry.id, item.entry.pageId) ?? fromItem(item),
              reasons: item.reasons,
              audit: {
                decisionId: item.decisionId,
                decision: item.decision,
                policy: item.policy,
              },
            },
          ]
        : [],
    ),
    ...proposals,
  ];
}

/** The rows carrying a reason, or every row when none is chosen. */
export function withReason(
  rows: ReviewRow[],
  reason: KnowledgeReviewReasonEnum | null,
): ReviewRow[] {
  return reason ? rows.filter((row) => row.reasons.includes(reason)) : rows;
}

/** How many rows carry each reason, the most common first. */
export function reasonFacets(
  rows: ReviewRow[],
): Array<{ reason: KnowledgeReviewReasonEnum; label: string; count: number }> {
  const counts = new Map<KnowledgeReviewReasonEnum, number>();

  for (const row of rows) {
    for (const reason of row.reasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, label: REASON_LABELS[reason], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * What an audit asks, and what each answer does. Agreeing keeps what triage
 * did; not agreeing undoes it, the way you would by hand.
 */
export function auditPrompt(audit: NonNullable<ReviewRow['audit']>): {
  question: string;
  agree: string;
  disagree: string;
} {
  switch (audit.decision) {
    case KnowledgeTriageDecisionEnum.AUTO_ACCEPT:
      return {
        question:
          'Triage put this into use without a person. Is it true, and worth giving agents?',
        agree: 'Right to use it',
        disagree: 'Set it aside',
      };
    case KnowledgeTriageDecisionEnum.CORROBORATE:
      return {
        question:
          'Triage took this as a repeat of a fact already here, and folded it in.',
        agree: 'Right, a repeat',
        disagree: 'Not a repeat: use it',
      };
    default:
      return {
        question:
          audit.policy === 'ONE_FACT'
            ? 'Triage refused this as several claims in one entry.'
            : 'Triage refused this on a policy.',
        agree: 'Right to refuse it',
        disagree: 'Use it',
      };
  }
}

/**
 * What a proposal asks, and what each answer does. Archiving takes the entry
 * out of use as you would by hand; keeping it leaves it in use, and the
 * gardener does not ask again for the same reason for a while.
 */
export function proposalPrompt(proposal: NonNullable<ReviewRow['proposal']>): {
  question: string;
  agree: string;
  disagree: string;
} {
  return {
    question: `${proposal.summary} Archive it?`,
    agree: 'Archive it',
    disagree: 'Keep it',
  };
}

/** A row's entry the store does not hold, as the endpoint sent it. */
function fromItem(item: KnowledgeReviewItem): PageEntryType {
  const createdAt = String(item.entry.createdAt);

  return {
    id: item.entry.id,
    pageId: item.entry.pageId,
    content: item.entry.content,
    scope: item.entry.scope,
    kind: item.entry.kind,
    status: item.entry.status,
    sourceUserId: item.entry.sourceUserId,
    createdAt,
    updatedAt: createdAt,
    retrievalCount: 0,
  };
}
