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
  lockEntry,
  lockEntryRow,
  putBackAt,
  readBefore,
  readBeforeActedOn,
  STORED_READING_SELECT,
  storedCheck,
} from '../entry-citations.service';
import KnowledgeIndexService from '../knowledge-index.service';
import {
  type CodeLandedJob,
  STANDING_ENTRY_DECAY_DAYS,
} from '../pages.interface';
import KnowledgeIssues from './knowledge-issues';
import {
  askedBecauseText,
  type CitationEvidence,
  IN_USE,
  type MaintenanceEvidence,
  citedByLivePages,
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
  /** Read before a person last acted on their entry, so read again. */
  stale: number;
}

/**
 * Raised when citations a change touches could not be read, or were read
 * before a person last acted on their entry, so the check is retried.
 */
export class UnreadCitations extends Error {
  constructor(
    readonly unread: number,
    readonly stale = 0,
  ) {
    super(
      `${unread} citation(s) touched by the change could not be read and ` +
        `${stale} were read before a person last acted on their entry; the ` +
        'check is retried',
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
 *   an archive proposal and the same issue. A contradiction a person put
 *   back, for the same words and the same code, is not raised again.
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
   * Checks and acts on the knowledge one landed change touches. Throws
   * `UnreadCitations` after acting on everything it could read, so the queue
   * tries the rest again, and the readings a person acted on the entry after.
   */
  async codeLanded(change: CodeLandedJob): Promise<LandedSummary> {
    await this.openOwedIssues(change.workspaceId);

    const { checks, unread } = await this.citations.recheckLanded(change);
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
      stale: 0,
    };

    for (const [entryId, entryChecks] of byEntry) {
      const { done, stale } = await this.settle(entryId, entryChecks, {
        sha: change.sha,
        externalRepoId: change.externalRepoId,
        repo: repo?.fullName ?? null,
        ...(change.since ? { since: change.since } : {}),
      });

      summary.stale += stale;
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
        `${summary.unread} unread, ${summary.stale} to read again`,
      where: 'KnowledgeUpkeepService.codeLanded',
    });

    if (unread > 0 || summary.stale > 0) {
      throw new UnreadCitations(unread, summary.stale);
    }

    return summary;
  }

  /**
   * Stores one entry's check results and does what they call for, in one
   * transaction, under the entry's lock. The maintenance row written, or
   * null when nothing was; and how many readings were taken before a person
   * last acted on the entry, which the caller reads again.
   *
   * A reading is stored only over an older one. What is acted on is what is
   * stored once the lock is held: this check's reading, or a newer one that
   * another change's check or a re-check stored first, whose head was asked
   * for later and so contains this change too. A re-check stores what it
   * finds without acting on it, so it is acted on here.
   *
   * A reading taken before a person last acted on the entry is not acted
   * on, and neither is a contradiction a person has already overruled: the
   * same citation's same code, judged for the same words, disputed and put
   * back.
   */
  private async settle(
    entryId: string,
    checks: LandedCheck[],
    change: NonNullable<MaintenanceEvidence['change']>,
  ): Promise<{
    done: {
      id: string;
      action: PageEntryMaintenanceAction;
      reason: PageEntryMaintenanceReason;
    } | null;
    stale: number;
  }> {
    return this.prisma.$transaction(async (tx) => {
      await lockEntry(tx, entryId);
      const readings: LandedCheck[] = [];

      for (const check of checks) {
        if (check.update) {
          const { count } = await tx.pageEntryCitation.updateMany({
            where: { id: check.citationId, ...readBefore(check.checkedAt) },
            data: check.update,
          });

          if (count > 0) {
            readings.push(check);
            continue;
          }
        }

        // Stored before this held the lock: by this job before it was
        // retried, by another change's check or by a re-check. Read again
        // under the lock, since a newer reading may have been stored after
        // the citation was first read.
        const row = await tx.pageEntryCitation.findFirst({
          where: { id: check.citationId },
          select: STORED_READING_SELECT,
        });
        const stored =
          row && storedCheck(row, { id: entryId, status: check.entryStatus });

        if (stored) {
          readings.push(stored);
        }
      }

      // As it is now, not as it was when the citations were read: a person
      // may have acted on it since. Its row is held first, so a person
      // rewording it or putting it out of use waits until this is done,
      // rather than landing between reading the entry and acting on it.
      await lockEntryRow(tx, entryId);
      const entry = await tx.pageEntry.findFirst({
        where: { id: entryId, deleted: null, status: { in: IN_USE } },
        select: {
          status: true,
          verifiedAt: true,
          contentHash: true,
          page: { select: { workspaceId: true, entryPolicy: true } },
        },
      });

      if (!entry) {
        return { done: null, stale: 0 };
      }

      const putBack = (await putBackAt(tx, [entryId])).get(entryId) ?? null;
      const current = readings.filter(
        (reading) => !readBeforeActedOn(reading, entry, putBack),
      );
      const stale = readings.length - current.length;
      const overruled = await this.overruled(tx, entryId, entry.contentHash);
      const [reason, found] = actionable(
        current.filter((reading) => !overruled.ruledOn(reading)),
      );

      if (!reason) {
        return { done: null, stale };
      }

      const evidence: MaintenanceEvidence = {
        change,
        citations: found.map(citationEvidence),
      };
      const workspaceId = entry.page.workspaceId;

      if (reason !== PageEntryMaintenanceReason.CITATION_CONTRADICTED) {
        return {
          done: await this.propose(tx, {
            workspaceId,
            entryId,
            reason,
            evidence,
          }),
          stale,
        };
      }

      const askedBecause: MaintenanceEvidence['askedBecause'] = entry.verifiedAt
        ? 'VERIFIED'
        : entry.page.entryPolicy === PageEntryPolicy.LOCKED
          ? 'LOCKED'
          : overruled.restored
            ? 'RESTORED'
            : null;

      if (askedBecause) {
        return {
          done: await this.propose(tx, {
            workspaceId,
            entryId,
            reason,
            evidence: { ...evidence, askedBecause },
          }),
          stale,
        };
      }

      const { count } = await tx.pageEntry.updateMany({
        where: {
          id: entryId,
          deleted: null,
          status: entry.status,
          verifiedAt: null,
        },
        data: { status: PageEntryStatus.DISPUTED },
      });

      if (count === 0) {
        return { done: null, stale };
      }

      // The claim disputed, so a person correcting it is told from a
      // person putting the same claim back.
      const disputed: MaintenanceEvidence = {
        ...evidence,
        claim: entry.contentHash,
        ...(entry.status === PageEntryStatus.CONSOLIDATED
          ? { consolidated: true }
          : {}),
      };

      return {
        done: await tx.pageEntryMaintenance.create({
          data: {
            workspaceId,
            entryId,
            action: PageEntryMaintenanceAction.DISPUTED,
            reason,
            evidence: disputed as Prisma.InputJsonValue,
          },
          select: { id: true, action: true, reason: true },
        }),
        stale,
      };
    });
  }

  /**
   * What people have said about the gardener disputing this entry within
   * the decay window, for the words it has now. `restored`: a person put
   * these words back after a dispute, so a new contradiction is asked about
   * rather than acted on. `ruledOn`: a judgment a person has overruled
   * already, of the same citation's same code, which is not raised again
   * however far the repository's head has moved. A dispute that recorded
   * no words counts for any.
   */
  private async overruled(
    tx: Prisma.TransactionClient,
    entryId: string,
    contentHash: string | null,
  ): Promise<{
    restored: boolean;
    ruledOn: (reading: LandedCheck) => boolean;
  }> {
    const undone = await tx.pageEntryMaintenance.findMany({
      where: {
        entryId,
        action: PageEntryMaintenanceAction.DISPUTED,
        reversedAt: { gte: daysAgo(STANDING_ENTRY_DECAY_DAYS) },
      },
      select: { evidence: true },
    });
    const forTheseWords = undone
      .map((row) => row.evidence as MaintenanceEvidence | null)
      .filter((evidence) => !evidence?.claim || evidence.claim === contentHash);

    return {
      restored: forTheseWords.length > 0,
      ruledOn: (reading) =>
        forTheseWords.some((evidence) =>
          (evidence?.citations ?? []).some(
            (citation) =>
              citation.citationId === reading.citationId &&
              citation.judgedCodeHash === reading.judgedCodeHash,
          ),
        ),
    };
  }

  /**
   * Asks a person to archive an entry, unless the queue already asks for the
   * same reason, or a person declined the same request about it within the
   * decay window: they have looked, and asking again on every change to the
   * file would teach them to ignore the queue. A request for another reason
   * does not stand in for it: a contradiction found while the entry is asked
   * about for going unused is still asked about, with its correction issue.
   * Under the entry's lock, so two callers never both ask. The proposal, or
   * null.
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
    await lockEntry(tx, proposal.entryId);

    const asked = await tx.pageEntryMaintenance.count({
      where: {
        entryId: proposal.entryId,
        action: PageEntryMaintenanceAction.ARCHIVE_PROPOSED,
        reason: proposal.reason,
        OR: [
          { proposalState: PageEntryProposalState.OPEN },
          {
            proposalState: PageEntryProposalState.DECLINED,
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
   * open or soon after a person declined it. Nor about one a live page
   * cites, which is read through the page. Run after each decay pass.
   */
  async proposeUnused(workspaceId?: string): Promise<number> {
    const cutoff = daysAgo(STANDING_ENTRY_DECAY_DAYS);
    const cited = await citedByLivePages(this.prisma, workspaceId);
    const candidates = await this.prisma.pageEntry.findMany({
      where: {
        deleted: null,
        status: PageEntryStatus.STANDING,
        verifiedAt: { not: null },
        page: workspaceId ? { workspaceId, deleted: null } : { deleted: null },
        ...unusedSince(cutoff),
        ...(cited.length ? { id: { notIn: cited } } : {}),
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
   * Opens the correction issues earlier runs owed and did not open, in one
   * workspace or, with none given, in every one: the issue is opened after
   * the change it reports is committed, and a run can fail in between. Each
   * row is claimed before its issue is opened, so two runs never open two
   * issues for one row.
   */
  async openOwedIssues(workspaceId?: string): Promise<number> {
    const owed = await this.prisma.pageEntryMaintenance.findMany({
      where: {
        ...(workspaceId && { workspaceId }),
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

/**
 * What an entry's readings call for, and the readings that call for it: a
 * contradiction first, then a file gone, then changed code no judge could
 * read. Nothing, when every cited line still holds or has only moved.
 */
function actionable(
  readings: LandedCheck[],
): [PageEntryMaintenanceReason | null, LandedCheck[]] {
  const contradicted = readings.filter(
    (check) =>
      check.result === PageEntryCitationCheckEnum.CHANGED &&
      check.judgment === PageEntryCitationJudgmentEnum.CONTRADICTED,
  );
  const missing = readings.filter(
    (check) => check.result === PageEntryCitationCheckEnum.MISSING,
  );
  const unjudged = readings.filter(
    (check) =>
      check.result === PageEntryCitationCheckEnum.CHANGED &&
      check.judgment !== PageEntryCitationJudgmentEnum.HOLDS &&
      check.judgment !== PageEntryCitationJudgmentEnum.CONTRADICTED,
  );

  return contradicted.length
    ? [PageEntryMaintenanceReason.CITATION_CONTRADICTED, contradicted]
    : missing.length
      ? [PageEntryMaintenanceReason.CITATION_MISSING, missing]
      : unjudged.length
        ? [PageEntryMaintenanceReason.CITATION_UNJUDGED, unjudged]
        : [null, []];
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
    judgedCodeHash: check.judgedCodeHash,
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
      : `${askedBecauseText(evidence.askedBecause)}, so it is still in use ` +
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
    ...(evidence.consolidated
      ? [
          'It was also written into the body of that page, which still says ' +
            'it: correct the body too.',
        ]
      : []),
    '',
    change ? changeText(change) : '',
    '',
    ...citations.flatMap((citation) => [citation, '']),
    'To close this: correct the entry so it says what the code does and ' +
      'put it back into use, or archive it if it no longer applies.',
  ].join('\n');
}

/**
 * What the check was of. A citation handed on after its first reading is
 * checked at the head against every change since the commit it was read at,
 * and which of them changed the cited code is not known, so no one commit is
 * named as the change. Nor is the head named: the check read whatever the
 * head was when it ran, which the citation's own line gives.
 */
function changeText(
  change: NonNullable<MaintenanceEvidence['change']>,
): string {
  const on = change.repo ? ` on ${change.repo}` : '';

  return change.since
    ? `It was checked at the head of the default branch${on}, against the ` +
        `changes that landed after \`${change.since}\`, the commit it was ` +
        'first read at.'
    : `The change landed as \`${change.sha}\`${on}.`;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
