import { Injectable, Optional } from '@nestjs/common';
import {
  PageEntryMaintenanceAction,
  PageEntryMaintenanceReason,
  PageEntryPolicy,
  PageEntryProposalState,
  PageEntryStatus,
  type Prisma,
} from '@prisma/client';
import {
  PageEntryCitationCheckEnum,
  PageEntryCitationJudgmentEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import EntryCitationsService, {
  type LandedCheck,
} from '../entry-citations.service';
import KnowledgeIndexService from '../knowledge-index.service';
import {
  type CodeLandedJob,
  STANDING_ENTRY_DECAY_DAYS,
} from '../pages.interface';
import KnowledgeIssues from './knowledge-issues';
import {
  type CitationEvidence,
  type MaintenanceEvidence,
  unusedSince,
} from './maintenance';
import { redactSecrets } from '../triage/triage-policy';

/**
 * How long a row may wait for its correction issue before another run opens
 * it. Longer than a run takes, so a run never opens the issue of a row
 * another run is still working on.
 */
const OWED_ISSUE_AFTER_MS = 10 * 60 * 1000;

/** Lines of a cited snippet quoted in a correction issue. */
const ISSUE_SNIPPET_LINES = 40;

/** What handling one landed change did. */
export interface LandedSummary {
  checked: number;
  disputed: number;
  proposed: number;
  unread: number;
}

/** Raised when citations a change touches could not be read, so it is retried. */
export class UnreadCitations extends Error {
  constructor(readonly unread: number) {
    super(
      `${unread} citation(s) touched by the change could not be read; the check is retried`,
    );
  }
}

/**
 * Keeps knowledge true as the code changes under it.
 *
 * When a change lands on a repository's default branch, every entry citing a
 * file it touched is checked again. A citation that still holds, or has only
 * moved, is refreshed. For an entry in use, what does not hold is acted on:
 *
 * - The code now contradicts the claim, as a judge read it: the entry is
 *   taken out of use as DISPUTED and a correction issue is opened for the
 *   team that owns the module. Disputed, not archived, because a model found
 *   it and a person can put it back.
 * - A person verified the entry, its page is locked, or a person already put
 *   it back after the gardener disputed it: the gardener asks instead, with
 *   an archive proposal and the same issue.
 * - A cited file is gone, or no judge could say whether the changed code
 *   still supports the claim: an archive proposal waits in the review queue.
 *   Neither is evidence the claim is false, only that nothing now shows it
 *   is true, so a person decides.
 *
 * An entry still waiting on triage is only checked: triage reads the fresh
 * results when it decides. Each change is recorded with what it rested on,
 * written in the same transaction as the citation results it came from.
 */
@Injectable()
export default class KnowledgeUpkeepService {
  private readonly logger = new LoggerService('KnowledgeUpkeepService');

  constructor(
    private prisma: PrismaService,
    private citations: EntryCitationsService,
    private issues: KnowledgeIssues,
    @Optional() private indexer?: KnowledgeIndexService,
  ) {}

  /**
   * Checks and acts on the knowledge one landed change touches. `since` is
   * when the job for it was queued. Throws `UnreadCitations` after acting on
   * everything it could read, so the queue tries the rest again.
   */
  async codeLanded(change: CodeLandedJob, since: Date): Promise<LandedSummary> {
    await this.openOwedIssues(change.workspaceId);

    const { checks, unread } = await this.citations.recheckLanded(
      change,
      since,
    );
    const repo = checks.length
      ? await this.prisma.moduleRepo.findFirst({
          where: {
            externalRepoId: change.externalRepoId,
            module: { workspaceId: change.workspaceId },
          },
          // The live row's name, when there is one.
          orderBy: { deleted: { sort: 'asc', nulls: 'first' } },
          select: { fullName: true },
        })
      : null;
    const byEntry = new Map<string, LandedCheck[]>();

    for (const check of checks) {
      byEntry.set(check.entryId, [
        ...(byEntry.get(check.entryId) ?? []),
        check,
      ]);
    }

    const summary: LandedSummary = {
      checked: checks.length,
      disputed: 0,
      proposed: 0,
      unread,
    };

    for (const [entryId, entryChecks] of byEntry) {
      const done = await this.settle(entryId, entryChecks, {
        sha: change.sha,
        externalRepoId: change.externalRepoId,
        repo: repo?.fullName ?? null,
      });

      await this.indexer?.entryChanged(entryId);

      if (done?.action === PageEntryMaintenanceAction.DISPUTED) {
        summary.disputed++;
      } else if (done) {
        summary.proposed++;
      }

      if (done?.reason === PageEntryMaintenanceReason.CITATION_CONTRADICTED) {
        await this.openCorrectionIssue(done.id);
      }
    }

    this.logger.info({
      message:
        `Checked ${summary.checked} citation(s) touched by ${change.sha.slice(0, 7)}: ` +
        `${summary.disputed} disputed, ${summary.proposed} proposed for archive, ` +
        `${summary.unread} unread`,
      where: 'KnowledgeUpkeepService.codeLanded',
    });

    if (unread > 0) {
      throw new UnreadCitations(unread);
    }

    return summary;
  }

  /**
   * Stores one entry's check results and does what they call for, in one
   * transaction. The maintenance row written, or null when nothing was.
   */
  private async settle(
    entryId: string,
    checks: LandedCheck[],
    change: NonNullable<MaintenanceEvidence['change']>,
  ): Promise<{
    id: string;
    action: PageEntryMaintenanceAction;
    reason: PageEntryMaintenanceReason;
  } | null> {
    const contradicted = checks.filter(
      (check) =>
        check.result === PageEntryCitationCheckEnum.CHANGED &&
        check.judgment === PageEntryCitationJudgmentEnum.CONTRADICTED,
    );
    const missing = checks.filter(
      (check) => check.result === PageEntryCitationCheckEnum.MISSING,
    );
    const unjudged = checks.filter(
      (check) =>
        check.result === PageEntryCitationCheckEnum.CHANGED &&
        check.judgment !== PageEntryCitationJudgmentEnum.HOLDS &&
        check.judgment !== PageEntryCitationJudgmentEnum.CONTRADICTED,
    );
    const [reason, found]: [PageEntryMaintenanceReason | null, LandedCheck[]] =
      contradicted.length
        ? [PageEntryMaintenanceReason.CITATION_CONTRADICTED, contradicted]
        : missing.length
          ? [PageEntryMaintenanceReason.CITATION_MISSING, missing]
          : unjudged.length
            ? [PageEntryMaintenanceReason.CITATION_UNJUDGED, unjudged]
            : [null, []];

    return this.prisma.$transaction(async (tx) => {
      for (const check of checks) {
        await tx.pageEntryCitation.update({
          where: { id: check.citationId },
          data: check.update,
        });
      }

      if (!reason) {
        return null;
      }

      // As it is now, not as it was when the citations were read: a person
      // may have acted on it since.
      const entry = await tx.pageEntry.findFirst({
        where: { id: entryId, deleted: null, status: PageEntryStatus.STANDING },
        select: {
          verifiedAt: true,
          page: { select: { workspaceId: true, entryPolicy: true } },
        },
      });

      if (!entry) {
        return null;
      }

      const evidence: MaintenanceEvidence = {
        change,
        citations: found.map(citationEvidence),
      };
      const workspaceId = entry.page.workspaceId;

      if (
        reason === PageEntryMaintenanceReason.CITATION_CONTRADICTED &&
        !entry.verifiedAt &&
        entry.page.entryPolicy !== PageEntryPolicy.LOCKED &&
        !(await this.overruled(tx, entryId))
      ) {
        const { count } = await tx.pageEntry.updateMany({
          where: {
            id: entryId,
            deleted: null,
            status: PageEntryStatus.STANDING,
            verifiedAt: null,
          },
          data: { status: PageEntryStatus.DISPUTED },
        });

        if (count === 0) {
          return null;
        }

        return tx.pageEntryMaintenance.create({
          data: {
            workspaceId,
            entryId,
            action: PageEntryMaintenanceAction.DISPUTED,
            reason,
            evidence: evidence as Prisma.InputJsonValue,
          },
          select: { id: true, action: true, reason: true },
        });
      }

      return this.propose(tx, { workspaceId, entryId, reason, evidence });
    });
  }

  /**
   * Whether a person put this entry back after the gardener disputed it,
   * within the decay window. The gardener then asks instead of disputing it
   * again on every change to the file: the person has read the code, and
   * the judge is a model.
   */
  private async overruled(
    tx: Prisma.TransactionClient,
    entryId: string,
  ): Promise<boolean> {
    return (
      (await tx.pageEntryMaintenance.count({
        where: {
          entryId,
          action: PageEntryMaintenanceAction.DISPUTED,
          reversedAt: { gte: daysAgo(STANDING_ENTRY_DECAY_DAYS) },
        },
      })) > 0
    );
  }

  /**
   * Asks a person to archive an entry, unless the queue already asks, or a
   * person declined the same request about it within the decay window: they
   * have looked, and asking again on every change to the file would teach
   * them to ignore the queue. The proposal, or null.
   */
  async propose(
    tx: Prisma.TransactionClient,
    proposal: {
      workspaceId: string;
      entryId: string;
      reason: PageEntryMaintenanceReason;
      evidence: MaintenanceEvidence;
    },
  ): Promise<{
    id: string;
    action: PageEntryMaintenanceAction;
    reason: PageEntryMaintenanceReason;
  } | null> {
    const asked = await tx.pageEntryMaintenance.count({
      where: {
        entryId: proposal.entryId,
        action: PageEntryMaintenanceAction.ARCHIVE_PROPOSED,
        OR: [
          { proposalState: PageEntryProposalState.OPEN },
          {
            proposalState: PageEntryProposalState.DECLINED,
            reason: proposal.reason,
            resolvedAt: { gte: daysAgo(STANDING_ENTRY_DECAY_DAYS) },
          },
        ],
      },
    });

    if (asked > 0) {
      return null;
    }

    return tx.pageEntryMaintenance.create({
      data: {
        workspaceId: proposal.workspaceId,
        entryId: proposal.entryId,
        action: PageEntryMaintenanceAction.ARCHIVE_PROPOSED,
        reason: proposal.reason,
        evidence: proposal.evidence as Prisma.InputJsonValue,
        proposalState: PageEntryProposalState.OPEN,
      },
      select: { id: true, action: true, reason: true },
    });
  }

  /**
   * Asks a person about each verified entry decay would otherwise archive:
   * in use, older than the window, and within it neither served nor found to
   * hold by a check. A person vouched for it, so decay never archives it
   * alone; the proposal waits in the review queue, and is not repeated while
   * open or soon after a person declined it. Run after each decay pass.
   */
  async proposeUnused(workspaceId?: string): Promise<number> {
    const cutoff = daysAgo(STANDING_ENTRY_DECAY_DAYS);
    const candidates = await this.prisma.pageEntry.findMany({
      where: {
        deleted: null,
        status: PageEntryStatus.STANDING,
        verifiedAt: { not: null },
        page: workspaceId ? { workspaceId, deleted: null } : { deleted: null },
        ...unusedSince(cutoff),
      },
      select: {
        id: true,
        lastServedAt: true,
        page: { select: { workspaceId: true } },
      },
    });
    let proposed = 0;

    for (const entry of candidates) {
      const row = await this.prisma.$transaction((tx) =>
        this.propose(tx, {
          workspaceId: entry.page.workspaceId,
          entryId: entry.id,
          reason: PageEntryMaintenanceReason.UNUSED,
          evidence: {
            windowDays: STANDING_ENTRY_DECAY_DAYS,
            lastServedAt: entry.lastServedAt?.toISOString() ?? null,
          },
        }),
      );

      if (row) {
        proposed++;
      }
    }

    return proposed;
  }

  /**
   * Opens the correction issues earlier runs owed and did not open: the
   * issue is opened after the change it reports is committed, and a run can
   * fail in between. Each row is claimed before its issue is opened, so two
   * runs never open two issues for one row.
   */
  async openOwedIssues(workspaceId: string): Promise<number> {
    const owed = await this.prisma.pageEntryMaintenance.findMany({
      where: {
        workspaceId,
        reason: PageEntryMaintenanceReason.CITATION_CONTRADICTED,
        issueId: null,
        reversedAt: null,
        updatedAt: { lt: new Date(Date.now() - OWED_ISSUE_AFTER_MS) },
        OR: [
          { action: PageEntryMaintenanceAction.DISPUTED },
          { proposalState: PageEntryProposalState.OPEN },
        ],
      },
      select: { id: true, updatedAt: true },
      take: 20,
    });
    let opened = 0;

    for (const row of owed) {
      const { count: claimed } =
        await this.prisma.pageEntryMaintenance.updateMany({
          where: { id: row.id, issueId: null, updatedAt: row.updatedAt },
          data: { updatedAt: new Date() },
        });

      if (claimed && (await this.openCorrectionIssue(row.id))) {
        opened++;
      }
    }

    return opened;
  }

  /**
   * Opens the correction issue for a claim the code now contradicts, and
   * records it on the row. It cites the entry, the change and the code the
   * judge read, each passed through the secret filter: cited code can hold
   * a credential the entry itself never could. A failure is logged and left
   * for a later run.
   */
  private async openCorrectionIssue(rowId: string): Promise<boolean> {
    try {
      const row = await this.prisma.pageEntryMaintenance.findUnique({
        where: { id: rowId },
        select: {
          id: true,
          workspaceId: true,
          action: true,
          evidence: true,
          issueId: true,
          entry: {
            select: {
              id: true,
              content: true,
              moduleIds: true,
              page: { select: { id: true, title: true } },
            },
          },
        },
      });

      if (!row || row.issueId) {
        return false;
      }

      const evidence = (row.evidence ?? {}) as MaintenanceEvidence;
      const cited = await this.prisma.pageEntryCitation.findMany({
        where: {
          id: { in: (evidence.citations ?? []).map((c) => c.citationId) },
        },
        select: {
          id: true,
          snippet: true,
          moduleRepo: { select: { moduleId: true } },
        },
      });
      const moduleIds = [
        ...new Set([
          ...cited.flatMap((c): string[] =>
            c.moduleRepo ? [c.moduleRepo.moduleId] : [],
          ),
          ...row.entry.moduleIds,
        ]),
      ];
      const issue = await this.issues.open({
        workspaceId: row.workspaceId,
        moduleIds,
        title: `Knowledge no longer matches the code: ${excerpt(row.entry.content)}`,
        markdown: correctionMarkdown(row, evidence, cited),
      });

      if (!issue) {
        this.logger.warn({
          message: `No team to hold the correction issue for entry ${row.entry.id}`,
          where: 'KnowledgeUpkeepService.openCorrectionIssue',
        });

        return false;
      }

      await this.prisma.pageEntryMaintenance.updateMany({
        where: { id: row.id, issueId: null },
        data: { issueId: issue.id },
      });

      return true;
    } catch (error) {
      this.logger.error({
        message: `Could not open the correction issue for maintenance ${rowId}`,
        where: 'KnowledgeUpkeepService.openCorrectionIssue',
        error,
      });

      return false;
    }
  }
}

function citationEvidence(check: LandedCheck): CitationEvidence {
  return {
    citationId: check.citationId,
    path: check.path,
    lines: `${check.startLine}-${check.endLine}`,
    readSha: check.readSha,
    result: check.result,
    judgment: check.judgment,
    judgeModel: check.judgeModel,
    judgeReason: check.judgeReason ? redactSecrets(check.judgeReason) : null,
  };
}

/** The first line of an entry, short enough for a title. */
function excerpt(content: string): string {
  const line = redactSecrets(content).split('\n')[0].trim();

  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function correctionMarkdown(
  row: {
    action: PageEntryMaintenanceAction;
    entry: { id: string; content: string; page: { id: string; title: string } };
  },
  evidence: MaintenanceEvidence,
  cited: Array<{ id: string; snippet: string | null }>,
): string {
  const change = evidence.change;
  const quoted = redactSecrets(row.entry.content)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const what =
    row.action === PageEntryMaintenanceAction.DISPUTED
      ? 'It was taken out of use (disputed), so agents are no longer given it.'
      : 'A person verified it, or its page is locked, so it is still in use ' +
        'and an archive proposal waits in the knowledge review queue.';
  const citations = (evidence.citations ?? []).map((citation) => {
    const snippet = cited.find((c) => c.id === citation.citationId)?.snippet;
    const lines = snippet
      ? redactSecrets(snippet).split('\n').slice(0, ISSUE_SNIPPET_LINES)
      : [];

    const read = citation.readSha
      ? `, read at \`${citation.readSha.slice(0, 7)}\``
      : '';

    return [
      `**\`${citation.path}\` lines ${citation.lines}**${read}`,
      ...(lines.length ? ['', 'As cited:', '', '```', ...lines, '```'] : []),
      ...(citation.judgeReason
        ? [
            '',
            `The judge${citation.judgeModel ? ` (${citation.judgeModel})` : ''} said: ${citation.judgeReason}`,
          ]
        : []),
    ].join('\n');
  });

  return [
    `A change to the code contradicts a knowledge entry agents are given.`,
    '',
    quoted,
    '',
    `Entry \`${row.entry.id}\` on the page "${row.entry.page.title}".`,
    what,
    '',
    change
      ? `The change landed as \`${change.sha}\`${change.repo ? ` on ${change.repo}` : ''}.`
      : '',
    '',
    ...citations.flatMap((citation) => [citation, '']),
    'To close this: correct the entry so it says what the code does and ' +
      'put it back into use, or archive it if it no longer applies.',
  ].join('\n');
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
