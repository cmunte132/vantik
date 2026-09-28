import {
  PageEntryCitationKind,
  PageEntryStatus,
  type Prisma,
} from '@prisma/client';
import { type PrismaService } from 'nestjs-prisma';

/**
 * How a knowledge gap comes to be answered: an entry citing the issue opened
 * for it is accepted. Kept apart from the job that opens the issues, so that
 * every place an entry is accepted can mark its gaps without depending on it.
 */

/**
 * What an entry that cites a gap's issue has to be for the gap to count as
 * answered: accepted, standing on its own or folded into its page's body.
 */
export const ACCEPTED: PageEntryStatus[] = [
  PageEntryStatus.STANDING,
  PageEntryStatus.CONSOLIDATED,
];

/** Whether an entry with this status counts as an accepted answer. */
export function isAccepted(status: string | null | undefined): boolean {
  return ACCEPTED.some((accepted) => accepted === status);
}

/** A database the gap writes go to: the client, or a transaction's. */
type Db = PrismaService | Prisma.TransactionClient;

/** An accepted entry citing an issue, in the workspace it was written in. */
export interface GapAnswer {
  workspaceId: string;
  issueId: string;
  entryId: string;
}

/**
 * Marks answered each unanswered gap whose issue one of these entries cites,
 * where the entry is accepted, and returns how many were marked. Called once
 * entries are accepted, from wherever that happens; entries that are not
 * accepted, or cite no gap's issue, change nothing.
 */
export async function answerGaps(
  prisma: Db,
  entryIds: string[],
): Promise<number> {
  if (!entryIds.length) {
    return 0;
  }

  const citations = await prisma.pageEntryCitation.findMany({
    where: {
      entryId: { in: entryIds },
      kind: PageEntryCitationKind.ISSUE,
      targetId: { not: null },
      entry: {
        deleted: null,
        status: { in: ACCEPTED },
        page: { deleted: null },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      entryId: true,
      targetId: true,
      entry: { select: { page: { select: { workspaceId: true } } } },
    },
  });

  return markAnswered(
    prisma,
    citations.map((citation) => ({
      workspaceId: citation.entry.page.workspaceId,
      issueId: citation.targetId as string,
      entryId: citation.entryId,
    })),
  );
}

/**
 * Marks each answer's gap answered by its entry. Only an unanswered gap is
 * written, so of several answers to one issue the first wins, and a gap
 * already answered keeps the entry that answered it. Only a gap in the
 * entry's own workspace is answered by it.
 */
export async function markAnswered(
  prisma: Db,
  answers: GapAnswer[],
): Promise<number> {
  const now = new Date();
  let answered = 0;

  for (const answer of answers) {
    const { count } = await prisma.pageKnowledgeGap.updateMany({
      where: {
        workspaceId: answer.workspaceId,
        issueId: answer.issueId,
        answeredAt: null,
      },
      data: { answeredAt: now, answeredByEntryId: answer.entryId },
    });

    answered += count;
  }

  return answered;
}
