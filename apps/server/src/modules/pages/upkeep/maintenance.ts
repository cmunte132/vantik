import {
  PageEntryCitationCheck,
  PageEntryCitationJudgment,
  PageEntryMaintenanceAction,
  PageEntryMaintenanceReason,
  PageEntryStatus,
  type Prisma,
} from '@prisma/client';
import { KnowledgeReviewReasonEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

/** One citation a change was checked against, as a maintenance row keeps it. */
export interface CitationEvidence {
  citationId: string;
  path: string;
  /** The lines it cited, as `10-14`. */
  lines: string;
  /** The commit it was read at; null when nothing could be read. */
  readSha: string | null;
  result: string;
  judgment: string | null;
  judgeModel: string | null;
  judgeReason: string | null;
}

/**
 * What a maintenance row rested on. Each kind of change fills its own part:
 * a change to the code the commit and the citations, decay the window and
 * when the entry was last served or held, a disabled convention its counts.
 */
export interface MaintenanceEvidence {
  change?: { sha: string; externalRepoId: string; repo: string | null };
  citations?: CitationEvidence[];
  windowDays?: number;
  lastServedAt?: string | null;
  harmful?: number;
  helpful?: number;
  margin?: number;
  /** Counted from here: the last time a person put the entry back. */
  since?: string | null;
}

/** The review queue's name for why the gardener asks. */
export function reviewReasonOf(
  reason: PageEntryMaintenanceReason,
): KnowledgeReviewReasonEnum {
  switch (reason) {
    case PageEntryMaintenanceReason.CITATION_CONTRADICTED:
      return KnowledgeReviewReasonEnum.CITATION_CONTRADICTED;
    case PageEntryMaintenanceReason.CITATION_MISSING:
      return KnowledgeReviewReasonEnum.CITATION_MISSING;
    case PageEntryMaintenanceReason.CITATION_UNJUDGED:
      return KnowledgeReviewReasonEnum.CITATION_UNJUDGED;
    case PageEntryMaintenanceReason.UNUSED:
      return KnowledgeReviewReasonEnum.UNUSED;
    case PageEntryMaintenanceReason.HARMFUL_SIGNALS:
      return KnowledgeReviewReasonEnum.HARMFUL_SIGNAL;
  }
}

/** A proposal as a reviewer reads it: what was found, where, and on what. */
export function proposalSummary(
  reason: PageEntryMaintenanceReason,
  evidence: MaintenanceEvidence | null,
): string {
  const citation = evidence?.citations?.[0];
  const where = citation
    ? `${citation.path} lines ${citation.lines}`
    : 'The code it cites';
  const at = citation?.readSha
    ? ` at ${citation.readSha.slice(0, 7)}`
    : evidence?.change
      ? ` after ${evidence.change.sha.slice(0, 7)}`
      : '';
  const repo = evidence?.change?.repo ? ` (${evidence.change.repo})` : '';
  const more =
    (evidence?.citations?.length ?? 0) > 1
      ? `, and ${(evidence?.citations?.length ?? 1) - 1} more`
      : '';
  const judge = citation?.judgeReason
    ? ` The judge said: ${citation.judgeReason}`
    : '';

  switch (reason) {
    case PageEntryMaintenanceReason.CITATION_MISSING:
      return `${where}${more} is gone${at}${repo}. Nothing it cited is there to hold it.`;
    case PageEntryMaintenanceReason.CITATION_UNJUDGED:
      return (
        `${where}${more} changed${at}${repo}, and no judge could say ` +
        `whether this still holds.${judge}`
      );
    case PageEntryMaintenanceReason.CITATION_CONTRADICTED:
      return (
        `${where}${more} changed${at}${repo}, and a judge found the code now ` +
        `contradicts this. A person verified it, or its page is locked, so ` +
        `it stays in use until you say.${judge}`
      );
    case PageEntryMaintenanceReason.UNUSED:
      return (
        `Neither served nor found to hold by a check in ` +
        `${evidence?.windowDays ?? 'the last'} days. A person verified it, so ` +
        `it is not archived without one.`
      );
    case PageEntryMaintenanceReason.HARMFUL_SIGNALS:
      return (
        `Runs that were given it went wrong ${evidence?.harmful ?? 0} times ` +
        `and right ${evidence?.helpful ?? 0}.`
      );
  }
}

/**
 * What a person undoes by putting an entry back into use: the changes the
 * gardener made alone that took it out, a dispute for a disputed entry and
 * an archive for an archived one. Written with the person's change, so the
 * record never says an entry is out of use while it is served. The gardener
 * reads these to ask, rather than act, the next time.
 */
export function reversalsFor(
  prisma: PrismaService,
  entries: ReadonlyArray<{ id: string; status: string }>,
  to: string,
  userId: string,
): Array<Prisma.PrismaPromise<unknown>> {
  if (to !== PageEntryStatus.STANDING) {
    return [];
  }

  const undone = [
    [PageEntryStatus.DISPUTED, PageEntryMaintenanceAction.DISPUTED],
    [PageEntryStatus.ARCHIVED, PageEntryMaintenanceAction.ARCHIVED],
  ] as const;
  const now = new Date();

  return undone.flatMap(([status, action]) => {
    const ids = entries
      .filter((entry) => entry.status === status)
      .map((entry) => entry.id);

    return ids.length
      ? [
          prisma.pageEntryMaintenance.updateMany({
            where: {
              entryId: { in: ids },
              action,
              proposalState: null,
              reversedAt: null,
            },
            data: { reversedAt: now, reversedById: userId },
          }),
        ]
      : [];
  });
}

/**
 * A citation found to hold by a check since `since`: the cited code is where
 * it was, or has moved and still reads the same, or changed and a judge read
 * it as still supporting the claim.
 */
export function heldSince(since: Date): Prisma.PageEntryCitationWhereInput {
  return {
    checkedAt: { gte: since },
    OR: [
      {
        checkResult: {
          in: [PageEntryCitationCheck.HOLDS, PageEntryCitationCheck.MOVED],
        },
      },
      {
        checkResult: PageEntryCitationCheck.CHANGED,
        judgment: PageEntryCitationJudgment.HOLDS,
      },
    ],
  };
}

/**
 * An entry decay may take out of use: older than the window, and within it
 * neither served nor found to hold by a check. Being checked and found to
 * hold is evidence the entry is still true, even if nobody asked for it;
 * being served is evidence it is still wanted. Either keeps it.
 */
export function unusedSince(cutoff: Date): Prisma.PageEntryWhereInput {
  return {
    createdAt: { lt: cutoff },
    OR: [{ lastServedAt: { lt: cutoff } }, { lastServedAt: null }],
    citations: { none: heldSince(cutoff) },
  };
}
