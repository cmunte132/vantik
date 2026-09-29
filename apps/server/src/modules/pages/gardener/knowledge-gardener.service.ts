import { Injectable, NotFoundException } from '@nestjs/common';
import {
  KnowledgeTriageDecisionType,
  KnowledgeTriageMode,
  PageEntryCitationCheck,
  PageEntryCitationKind,
  PageEntryMaintenanceAction,
  PageEntryMaintenanceReason,
  PageEntryRelationType,
  PageEntrySignalKind,
  PageEntryStatus,
} from '@prisma/client';
import {
  KnowledgeTrustEnum,
  type KnowledgeFactFlow,
  type KnowledgeGardener,
  type KnowledgeGardenerEvent,
  type KnowledgeGardenerJob,
  type KnowledgeGardenerStat,
  type KnowledgeMap,
  type KnowledgeMapEdge,
  type KnowledgeMapFactState,
  type KnowledgeMapMark,
  type KnowledgeMapNode,
  type KnowledgePackCandidate,
  type KnowledgeRunTrace,
  type KnowledgeTracedRun,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { KnowledgeArmsService } from 'modules/agent-runs/knowledge-arms.service';
import { integrationBotEmail } from 'modules/integration-events/integration-bot';

import { entryTrust, PROOF_CITATION_SELECT } from '../knowledge-proof';
import {
  CODE_LANDED_JOB,
  DECAY_JOB,
  GAP_ISSUES_JOB,
  PAGE_REFRESH_JOB,
  RECHECK_ENTRY_JOB,
  RETRY_CITATIONS_JOB,
  RUN_FINDINGS_JOB,
  TRIAGE_ENTRY_JOB,
  VERIFY_ENTRY_JOB,
} from '../pages.interface';
import KnowledgeAgreementService from '../triage/knowledge-agreement.service';
import { KNOWLEDGE_BOT } from '../upkeep/knowledge-issues';

const DAY = 86_400_000;

/** How far back the flow of facts and the log look. */
const WINDOW_DAYS = 30;

/** Fewer runs than this in the arm held out, and the comparison is noise. */
const MIN_HOLDOUT_RUNS = 10;

/** The most runs the map draws. */
const MAX_MAP_RUNS = 40;

/** The jobs the gardener view lists, in the order it lists them. */
export const GARDENER_JOBS = [
  TRIAGE_ENTRY_JOB,
  CODE_LANDED_JOB,
  RUN_FINDINGS_JOB,
  GAP_ISSUES_JOB,
  DECAY_JOB,
  PAGE_REFRESH_JOB,
  VERIFY_ENTRY_JOB,
  RECHECK_ENTRY_JOB,
  RETRY_CITATIONS_JOB,
];

const ACCEPTED: PageEntryStatus[] = [
  PageEntryStatus.STANDING,
  PageEntryStatus.CONSOLIDATED,
];

const RETIRED: PageEntryStatus[] = [
  PageEntryStatus.ARCHIVED,
  PageEntryStatus.SUPERSEDED,
  PageEntryStatus.DISPUTED,
];

const DECISION_LABELS: Record<KnowledgeTriageDecisionType, string> = {
  AUTO_ACCEPT: 'accepting facts',
  CORROBORATE: 'folding in repeats',
  ESCALATE: 'escalating',
  REJECT: 'refusing facts',
};

const REASON_LABELS: Record<PageEntryMaintenanceReason, string> = {
  CITATION_CONTRADICTED: 'the code contradicts it',
  CITATION_MISSING: 'the file it cites is gone',
  CITATION_UNJUDGED: 'its citation could not be judged',
  UNUSED: 'nobody used it in 90 days',
  HARMFUL_SIGNALS: 'runs went wrong with it',
};

/**
 * What the gardener does, for people: the gardener view, the map of what
 * the workspace knows, and the trace of one run's pack.
 *
 * Everything here is read from records the gardener already keeps. Nothing
 * is counted twice: a fact is in one place in the flow, and a run is one
 * node on the map however many facts it was given.
 */
@Injectable()
export default class KnowledgeGardenerService {
  constructor(
    private prisma: PrismaService,
    private agreement: KnowledgeAgreementService,
    private arms: KnowledgeArmsService,
  ) {}

  async gardener(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<KnowledgeGardener> {
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const monthAgo = new Date(now.getTime() - WINDOW_DAYS * DAY);
    const report = await this.agreement.report(workspaceId);

    const [settled, withKnowledge, citations, flow, events, jobs] =
      await Promise.all([
        this.settledStat(workspaceId, weekAgo),
        this.withKnowledgeStat(workspaceId),
        this.citationsStat(workspaceId, weekAgo),
        this.flow(workspaceId, monthAgo),
        this.events(workspaceId, monthAgo),
        this.jobs(workspaceId, weekAgo),
      ]);

    return {
      autoTriage: report.autoTriage,
      settled,
      agreement: agreementStat(report),
      withKnowledge,
      citations,
      flow,
      events,
      jobs,
    };
  }

  /** Facts triage settled without a person this week, of those agents wrote. */
  private async settledStat(
    workspaceId: string,
    since: Date,
  ): Promise<KnowledgeGardenerStat> {
    const decisions = await this.prisma.knowledgeTriageDecision.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since },
        entry: { workspaceId, deleted: null },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        entryId: true,
        decision: true,
        mode: true,
        applied: true,
        entry: { select: { citations: { select: { kind: true } } } },
      },
    });
    // The latest decision about each entry is where it stands.
    const latest = new Map(
      decisions.map((decision) => [decision.entryId, decision]),
    );
    const all = [...latest.values()];
    const alone = all.filter(
      (decision) =>
        decision.applied &&
        decision.mode === KnowledgeTriageMode.ON &&
        decision.decision !== KnowledgeTriageDecisionType.ESCALATE,
    );
    const observed = alone.filter((decision) =>
      decision.entry.citations.some(
        (citation) => citation.kind === PageEntryCitationKind.URL,
      ),
    ).length;

    if (all.length === 0) {
      return {
        value: null,
        tone: 'plain',
        note: 'Triage decided nothing this week.',
      };
    }

    return {
      value: `${alone.length} of ${all.length}`,
      tone: 'good',
      note:
        alone.length === 0
          ? 'A person decided every one.'
          : `The code or a repeat settled ${alone.length - observed}; ${observed} rest on an outside page.`,
    };
  }

  /** Runs whose checks passed, with the workspace's facts and without. */
  private async withKnowledgeStat(
    workspaceId: string,
  ): Promise<KnowledgeGardenerStat> {
    const { arms } = await this.arms.compare(workspaceId, null);
    const treated = arms.find((arm) => arm.arm === 'TREATMENT');
    const held = arms.find((arm) => arm.arm === 'HOLDOUT');
    const rate = (value: number | null | undefined) =>
      value === null || value === undefined
        ? '–'
        : `${Math.round(value * 100)}%`;

    if (!treated?.runs && !held?.runs) {
      return {
        value: null,
        tone: 'plain',
        note: 'No agent run has finished yet.',
      };
    }

    const heldRuns = held?.verification.of ?? 0;

    return {
      value: `${rate(treated?.verification.rate)} vs ${rate(held?.verification.rate)}`,
      tone: 'plain',
      note:
        heldRuns < MIN_HOLDOUT_RUNS
          ? `Only ${heldRuns} run${heldRuns === 1 ? '' : 's'} without facts: too few to trust yet.`
          : `${treated?.verification.of ?? 0} runs with facts, ${heldRuns} without.`,
    };
  }

  /** Code citations of facts in use that still held when checked this week. */
  private async citationsStat(
    workspaceId: string,
    since: Date,
  ): Promise<KnowledgeGardenerStat> {
    const checked = await this.prisma.pageEntryCitation.findMany({
      where: {
        kind: PageEntryCitationKind.CODE,
        checkedAt: { gte: since },
        checkResult: { not: PageEntryCitationCheck.UNKNOWN },
        entry: {
          workspaceId,
          deleted: null,
          status: { in: ACCEPTED },
        },
      },
      select: { entryId: true, checkResult: true },
    });

    if (checked.length === 0) {
      return {
        value: null,
        tone: 'plain',
        note: 'No fact was checked against the code this week.',
      };
    }

    const holding = checked.filter(
      (citation) =>
        citation.checkResult === PageEntryCitationCheck.HOLDS ||
        citation.checkResult === PageEntryCitationCheck.MOVED,
    ).length;
    const gone = new Set(
      checked
        .filter(
          (citation) => citation.checkResult === PageEntryCitationCheck.MISSING,
        )
        .map((citation) => citation.entryId),
    ).size;
    const changed = new Set(
      checked
        .filter(
          (citation) => citation.checkResult === PageEntryCitationCheck.CHANGED,
        )
        .map((citation) => citation.entryId),
    ).size;
    const share = Math.round((holding / checked.length) * 100);

    return {
      value: `${share}%`,
      tone: share >= 90 ? 'good' : 'warn',
      note:
        gone + changed === 0
          ? `All ${checked.length} citations checked still hold.`
          : `${[
              gone ? `${gone} cite files that are gone` : null,
              changed ? `${changed} cite code that changed` : null,
            ]
              .filter(Boolean)
              .join('; ')}.`,
    };
  }

  /** Where each fact written in the window is now. */
  async flow(workspaceId: string, since: Date): Promise<KnowledgeFactFlow> {
    const [written, given, signals, retired] = await Promise.all([
      this.prisma.pageEntry.findMany({
        where: { workspaceId, deleted: null, createdAt: { gte: since } },
        select: {
          id: true,
          status: true,
          verifiedAt: true,
          triageDecisions: {
            where: { applied: true, mode: KnowledgeTriageMode.ON },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { decision: true },
          },
        },
      }),
      this.prisma.pageEntryUse.count({
        where: {
          workspaceId,
          createdAt: { gte: since },
          agentRunId: { not: null },
        },
      }),
      this.prisma.pageEntrySignal.findMany({
        where: {
          createdAt: { gte: since },
          entry: { workspaceId },
          agentRun: { workspaceId },
        },
        select: { agentRunId: true, kind: true },
      }),
      this.prisma.pageEntry.findMany({
        where: {
          workspaceId,
          deleted: null,
          status: { in: RETIRED },
          updatedAt: { gte: since },
        },
        select: {
          id: true,
          status: true,
          triageDecisions: {
            where: { applied: true, mode: KnowledgeTriageMode.ON },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { decision: true },
          },
          maintenance: {
            where: { reversedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { reason: true, action: true },
          },
        },
      }),
    ]);

    const flow: KnowledgeFactFlow = {
      windowDays: WINDOW_DAYS,
      written: written.length,
      refused: 0,
      folded: 0,
      settledByAgents: 0,
      decidedByPeople: 0,
      waiting: 0,
      inUse: 0,
      givenTimes: given,
      runsWell: new Set(
        signals
          .filter((signal) => signal.kind === PageEntrySignalKind.HELPFUL)
          .map((signal) => signal.agentRunId),
      ).size,
      runsWrong: new Set(
        signals
          .filter((signal) => signal.kind === PageEntrySignalKind.HARMFUL)
          .map((signal) => signal.agentRunId),
      ).size,
      retired: 0,
      retiredContradicted: 0,
      retiredUnused: 0,
      retiredReplaced: 0,
      retiredOther: 0,
    };

    for (const entry of written) {
      const decision = entry.triageDecisions[0]?.decision;

      if (entry.status === PageEntryStatus.PROPOSED) {
        flow.waiting += 1;
      } else if (!entry.verifiedAt && decision === 'REJECT') {
        flow.refused += 1;
      } else if (!entry.verifiedAt && decision === 'CORROBORATE') {
        flow.folded += 1;
      } else if (!entry.verifiedAt && decision === 'AUTO_ACCEPT') {
        flow.settledByAgents += 1;
      } else {
        flow.decidedByPeople += 1;
      }

      if (ACCEPTED.includes(entry.status)) {
        flow.inUse += 1;
      }
    }

    for (const entry of retired) {
      const decision = entry.triageDecisions[0]?.decision;

      // Refused and folded are counted where the fact was written.
      if (decision === 'REJECT' || decision === 'CORROBORATE') {
        continue;
      }

      flow.retired += 1;
      const reason = entry.maintenance[0]?.reason;

      if (entry.status === PageEntryStatus.SUPERSEDED) {
        flow.retiredReplaced += 1;
      } else if (
        reason === 'CITATION_CONTRADICTED' ||
        reason === 'CITATION_MISSING'
      ) {
        flow.retiredContradicted += 1;
      } else if (reason === 'UNUSED') {
        flow.retiredUnused += 1;
      } else {
        flow.retiredOther += 1;
      }
    }

    return flow;
  }

  /** What the gardener did in the window, newest first. */
  private async events(
    workspaceId: string,
    since: Date,
  ): Promise<KnowledgeGardenerEvent[]> {
    const bot = await this.prisma.user.findFirst({
      where: { email: integrationBotEmail(KNOWLEDGE_BOT.slug, workspaceId) },
      select: { id: true },
    });

    const [maintenance, replaced, conventions, backoff, escalated] =
      await Promise.all([
        this.prisma.pageEntryMaintenance.findMany({
          where: {
            workspaceId,
            createdAt: { gte: since },
            entry: { workspaceId },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            createdAt: true,
            entryId: true,
            action: true,
            reason: true,
            reversedAt: true,
            entry: { select: { content: true } },
          },
        }),
        this.prisma.pageEntry.findMany({
          where: {
            workspaceId,
            deleted: null,
            supersedesId: { not: null },
            status: { in: ACCEPTED },
            updatedAt: { gte: since },
            supersedes: { status: PageEntryStatus.SUPERSEDED },
          },
          orderBy: { updatedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            updatedAt: true,
            content: true,
            verifiedAt: true,
            supersedes: { select: { content: true } },
          },
        }),
        bot
          ? this.prisma.pageEntry.findMany({
              where: {
                workspaceId,
                deleted: null,
                kind: 'CONVENTION',
                sourceUserId: bot.id,
                createdAt: { gte: since },
              },
              orderBy: { createdAt: 'desc' },
              take: 10,
              select: {
                id: true,
                createdAt: true,
                content: true,
                scope: true,
              },
            })
          : Promise.resolve([]),
        this.prisma.knowledgeBackoffChange.findMany({
          where: { workspaceId, createdAt: { gte: since } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        this.prisma.knowledgeTriageDecision.findMany({
          where: {
            workspaceId,
            createdAt: { gte: since },
            decision: KnowledgeTriageDecisionType.ESCALATE,
            trigger: { in: ['CODE_CHANGED', 'CITATIONS_CHECKED'] },
            entry: { workspaceId, status: PageEntryStatus.PROPOSED },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            createdAt: true,
            entryId: true,
            trigger: true,
            entry: { select: { content: true } },
          },
        }),
      ]);

    const inbox = await this.prisma.knowledgeInboxItem.findMany({
      where: {
        workspaceId,
        subjectId: {
          in: [
            ...escalated.map((decision) => decision.entryId),
            ...maintenance.map((row) => row.id),
          ],
        },
      },
      select: { id: true, subjectId: true },
    });
    const inboxOf = new Map(inbox.map((item) => [item.subjectId, item.id]));

    const events: KnowledgeGardenerEvent[] = [
      ...maintenance.map((row): KnowledgeGardenerEvent => {
        const fact = `“${brief(row.entry.content)}”`;
        const reason = REASON_LABELS[row.reason];
        const undone = row.reversedAt ? ' A person undid it.' : '';

        switch (row.action) {
          case PageEntryMaintenanceAction.ARCHIVE_PROPOSED:
            return {
              id: row.id,
              at: row.createdAt,
              kind: 'proposed-archive',
              title: 'Asked a person to retire a fact',
              detail: `${fact} · ${reason} · sent to Needs you`,
              entryId: row.entryId,
              inboxItemId: inboxOf.get(row.id) ?? null,
            };
          case PageEntryMaintenanceAction.DISPUTED:
            return {
              id: row.id,
              at: row.createdAt,
              kind: 'contradicted',
              title:
                row.reason === 'CITATION_CONTRADICTED'
                  ? 'A change in the code contradicted a fact'
                  : 'Took a fact out of use',
              detail: `${fact} · ${reason}.${undone}`,
              entryId: row.entryId,
              inboxItemId: null,
            };
          default:
            return {
              id: row.id,
              at: row.createdAt,
              kind: 'archived',
              title: 'Retired a fact',
              detail: `${fact} · ${reason}.${undone}`,
              entryId: row.entryId,
              inboxItemId: null,
            };
        }
      }),
      ...replaced.map((entry): KnowledgeGardenerEvent => ({
        id: `replaced-${entry.id}`,
        at: entry.updatedAt,
        kind: 'replaced',
        title: `Replaced “${brief(entry.supersedes?.content ?? '')}”`,
        detail: `“${brief(entry.content)}” is in use now${
          entry.verifiedAt ? ', confirmed by a person' : ''
        }; the old fact is retired.`,
        entryId: entry.id,
        inboxItemId: null,
      })),
      ...conventions.map((entry): KnowledgeGardenerEvent => ({
        id: `convention-${entry.id}`,
        at: entry.createdAt,
        kind: 'convention',
        title: `Proposed a convention${entry.scope ? ` for ${entry.scope}` : ''}`,
        detail: `“${brief(entry.content)}” · the reviewer found it in several runs`,
        entryId: entry.id,
        inboxItemId: null,
      })),
      ...backoff.map((change): KnowledgeGardenerEvent => ({
        id: change.id,
        at: change.createdAt,
        kind: change.backedOff ? 'backoff' : 'resumed',
        title: change.backedOff
          ? `Paused ${DECISION_LABELS[change.decision]}`
          : `Resumed ${DECISION_LABELS[change.decision]}`,
        detail: `People agreed κ ${
          change.kappa === null ? '–' : change.kappa.toFixed(2)
        } over ${change.samples} verdicts (floor ${change.floor}). ${
          change.backedOff
            ? 'A person now decides each one.'
            : 'Triage acts alone again.'
        }`,
        entryId: null,
        inboxItemId: null,
      })),
      ...escalated.map((decision): KnowledgeGardenerEvent => ({
        id: decision.id,
        at: decision.createdAt,
        kind: 'escalated',
        title:
          decision.trigger === 'CODE_CHANGED'
            ? 'A commit put a fact in doubt'
            : 'A check put a fact in doubt',
        detail: `“${brief(decision.entry.content)}” · sent to Needs you`,
        entryId: decision.entryId,
        inboxItemId: inboxOf.get(decision.entryId) ?? null,
      })),
    ];

    return events
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 12);
  }

  /** Each job: its last run here or across every workspace, and its week. */
  private async jobs(
    workspaceId: string,
    since: Date,
  ): Promise<KnowledgeGardenerJob[]> {
    const mine = { OR: [{ workspaceId }, { workspaceId: null }] };
    const [runs, outcomes] = await Promise.all([
      this.prisma.knowledgeJobRun.findMany({
        where: {
          ...mine,
          job: { in: GARDENER_JOBS },
          startedAt: { gte: since },
        },
        select: { job: true, error: true, startedAt: true },
      }),
      this.outcomes(workspaceId, since),
    ]);
    const last = await Promise.all(
      GARDENER_JOBS.map((job) =>
        this.prisma.knowledgeJobRun.findFirst({
          where: { ...mine, job },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true, error: true },
        }),
      ),
    );

    return GARDENER_JOBS.map((job, index) => {
      const week = runs.filter((run) => run.job === job);

      return {
        job,
        lastRunAt: last[index]?.startedAt ?? null,
        lastError: last[index]?.error ?? null,
        runsThisWeek: week.length,
        failedThisWeek: week.filter((run) => run.error).length,
        outcome: outcomes[job] ?? null,
      };
    });
  }

  /** What each job did in this workspace this week, as a sentence. */
  private async outcomes(
    workspaceId: string,
    since: Date,
  ): Promise<Record<string, string | null>> {
    const [decisions, landed, findings, gaps, unused, refreshed, verified] =
      await Promise.all([
        this.prisma.knowledgeTriageDecision.findMany({
          where: { workspaceId, createdAt: { gte: since } },
          select: { decision: true, applied: true, mode: true },
        }),
        this.prisma.knowledgeJobRun.findMany({
          where: {
            workspaceId,
            job: CODE_LANDED_JOB,
            startedAt: { gte: since },
          },
          select: { counts: true },
        }),
        this.prisma.knowledgeFinding.count({
          where: { workspaceId, createdAt: { gte: since } },
        }),
        Promise.all([
          this.prisma.pageKnowledgeGap.count({
            where: { workspaceId, answeredAt: null, count: { gte: 2 } },
          }),
          this.prisma.pageKnowledgeGap.count({
            where: { workspaceId, answeredAt: { gte: since } },
          }),
        ]),
        this.prisma.pageEntryMaintenance.count({
          where: {
            workspaceId,
            createdAt: { gte: since },
            reason: PageEntryMaintenanceReason.UNUSED,
          },
        }),
        this.prisma.page.count({
          where: { workspaceId, deleted: null, refreshedAt: { gte: since } },
        }),
        this.prisma.knowledgeVerification.findMany({
          where: { workspaceId, finishedAt: { gte: since } },
          select: { found: true },
        }),
      ]);

    const settled = decisions.filter(
      (decision) =>
        decision.applied &&
        decision.mode === KnowledgeTriageMode.ON &&
        decision.decision !== 'ESCALATE',
    ).length;
    const escalated = decisions.filter(
      (decision) => decision.decision === 'ESCALATE',
    ).length;
    const waiting = landed.reduce(
      (sum, run) =>
        sum + (((run.counts ?? {}) as { waiting?: number }).waiting ?? 0),
      0,
    );

    return {
      [TRIAGE_ENTRY_JOB]: decisions.length
        ? `${decisions.length} this week: ${settled} settled, ${escalated} sent to Needs you`
        : null,
      [CODE_LANDED_JOB]: landed.length
        ? `Checked ${landed.length} change${landed.length === 1 ? '' : 's'}; ${waiting} fact${waiting === 1 ? '' : 's'} put in doubt`
        : null,
      [RUN_FINDINGS_JOB]: findings
        ? `Recorded ${findings} review finding${findings === 1 ? '' : 's'}`
        : null,
      [GAP_ISSUES_JOB]: `${gaps[1]} gap${gaps[1] === 1 ? '' : 's'} closed · ${gaps[0]} still open`,
      [DECAY_JOB]: unused
        ? `Retired or asked about ${unused} fact${unused === 1 ? '' : 's'} nobody used in 90 days`
        : null,
      [PAGE_REFRESH_JOB]: refreshed
        ? `Rebuilt ${refreshed} page${refreshed === 1 ? '' : 's'} whose evidence changed`
        : null,
      [VERIFY_ENTRY_JOB]: verified.length
        ? `Looked for evidence of ${verified.length} fact${verified.length === 1 ? '' : 's'}; found some for ${verified.filter((row) => row.found > 0).length}`
        : null,
    };
  }

  /**
   * The graph of what the workspace knows, as it stood at the end of a day:
   * modules, facts, pages, the files and issues facts cite, and the runs
   * they were given to.
   *
   * No status history is stored, so a fact's state on a past day is read
   * from the rows that date each change: its acceptance by triage or a
   * person, and its retirement by the gardener, triage or a replacement.
   */
  async map(
    workspaceId: string,
    asOf?: string,
    now: Date = new Date(),
  ): Promise<KnowledgeMap> {
    const until = asOf ? endOfDay(new Date(asOf)) : now;
    const monthBefore = new Date(until.getTime() - WINDOW_DAYS * DAY);

    const [entries, modules, products, relations, uses, first, openInbox] =
      await Promise.all([
        this.prisma.pageEntry.findMany({
          where: { workspaceId, deleted: null, createdAt: { lte: until } },
          select: {
            id: true,
            content: true,
            kind: true,
            status: true,
            pageId: true,
            moduleIds: true,
            verifiedAt: true,
            createdAt: true,
            updatedAt: true,
            supersedesId: true,
            citations: {
              select: {
                ...PROOF_CITATION_SELECT,
                path: true,
                targetId: true,
                targetLabel: true,
                createdAt: true,
              },
            },
            maintenance: {
              where: {
                action: {
                  in: [
                    PageEntryMaintenanceAction.ARCHIVED,
                    PageEntryMaintenanceAction.DISPUTED,
                  ],
                },
              },
              select: { createdAt: true, reversedAt: true },
            },
            triageDecisions: {
              where: { applied: true, mode: KnowledgeTriageMode.ON },
              select: { decision: true, createdAt: true },
            },
          },
        }),
        this.prisma.module.findMany({
          where: { workspaceId, deleted: null },
          select: {
            id: true,
            name: true,
            ownerProductId: true,
            linkedProductIds: true,
          },
        }),
        this.prisma.product.findMany({
          where: { workspaceId, deleted: null },
          select: { id: true, name: true, color: true },
        }),
        this.prisma.pageEntryRelation.findMany({
          where: {
            from: { workspaceId },
            to: { workspaceId },
            createdAt: { lte: until },
            type: {
              in: [
                PageEntryRelationType.CONTRADICTS,
                PageEntryRelationType.REFINES,
                PageEntryRelationType.SUPERSEDES,
              ],
            },
          },
          select: { fromId: true, toId: true, type: true, createdAt: true },
        }),
        this.prisma.pageEntryUse.findMany({
          where: {
            workspaceId,
            agentRunId: { not: null },
            createdAt: { gte: monthBefore, lte: until },
          },
          orderBy: { createdAt: 'desc' },
          select: { entryId: true, agentRunId: true },
        }),
        this.prisma.pageEntry.findFirst({
          where: { workspaceId, deleted: null },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.prisma.knowledgeInboxItem.findMany({
          where: { workspaceId, doneAt: null },
          select: { subjectId: true },
        }),
      ]);

    const waitingOnPeople = new Set(openInbox.map((item) => item.subjectId));
    const today = until.getTime() >= now.getTime() - DAY;
    const nodes: KnowledgeMapNode[] = [];
    const edges: KnowledgeMapEdge[] = [];
    const marks: KnowledgeMapMark[] = [];
    const seen = new Set<string>();
    const add = (node: KnowledgeMapNode) => {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        nodes.push(node);
      }
    };

    const productById = new Map(
      products.map((product) => [product.id, product]),
    );
    const moduleIds = new Set(modules.map((module) => module.id));
    const pageIds = new Set<string>();

    for (const module of modules) {
      const productId =
        module.ownerProductId ?? module.linkedProductIds[0] ?? null;

      add({
        id: module.id,
        type: 'module',
        label: module.name,
        productId,
        color: productId ? (productById.get(productId)?.color ?? null) : null,
      });
    }

    for (const entry of entries) {
      const state = stateAsOf(entry, until, today, waitingOnPeople);

      add({
        id: entry.id,
        type: 'fact',
        label: brief(entry.content),
        state,
        kind: entry.kind,
        pageId: entry.pageId,
        moduleIds: entry.moduleIds.filter((id) => moduleIds.has(id)),
      });

      for (const id of entry.moduleIds) {
        if (moduleIds.has(id)) {
          edges.push({ from: entry.id, to: id, type: 'part-of' });
        }
      }

      if (entry.pageId) {
        pageIds.add(entry.pageId);
        edges.push({ from: entry.id, to: entry.pageId, type: 'part-of' });
      }

      for (const citation of entry.citations) {
        if (citation.createdAt > until) {
          continue;
        }

        if (citation.kind === PageEntryCitationKind.CODE && citation.path) {
          const id = `file:${citation.path}`;
          add({ id, type: 'file', label: citation.path });
          edges.push({ from: entry.id, to: id, type: 'cites-code' });
        }

        if (
          citation.kind === PageEntryCitationKind.ISSUE &&
          citation.targetId
        ) {
          const id = `issue:${citation.targetId}`;
          add({
            id,
            type: 'issue',
            label: citation.targetLabel ?? 'An issue',
            issueKey: citation.targetLabel,
          });
          edges.push({ from: entry.id, to: id, type: 'cites-issue' });
        }
      }

      if (entry.supersedesId) {
        edges.push({
          from: entry.id,
          to: entry.supersedesId,
          type: 'replaced',
        });
      }

      const retiredAt = retiredTime(entry);
      if (retiredAt && retiredAt <= until) {
        marks.push({
          at: retiredAt,
          type:
            entry.status === PageEntryStatus.SUPERSEDED
              ? 'replaced'
              : 'retired',
        });
      }
    }

    for (const relation of relations) {
      const type =
        relation.type === PageEntryRelationType.CONTRADICTS
          ? 'contradicts'
          : relation.type === PageEntryRelationType.REFINES
            ? 'refines'
            : 'replaced';

      if (
        type === 'replaced' &&
        edges.some(
          (edge) =>
            edge.type === 'replaced' &&
            ((edge.from === relation.fromId && edge.to === relation.toId) ||
              (edge.from === relation.toId && edge.to === relation.fromId)),
        )
      ) {
        continue;
      }

      edges.push({ from: relation.fromId, to: relation.toId, type });

      if (type === 'contradicts') {
        marks.push({ at: relation.createdAt, type: 'contradicts' });
      }
    }

    const pages = pageIds.size
      ? await this.prisma.page.findMany({
          where: {
            id: { in: [...pageIds] },
            workspaceId,
            deleted: null,
          },
          select: {
            id: true,
            title: true,
            links: {
              where: { deleted: null, entityType: 'MODULE' },
              select: { entityId: true },
            },
          },
        })
      : [];

    for (const page of pages) {
      add({ id: page.id, type: 'page', label: page.title });

      for (const link of page.links) {
        if (moduleIds.has(link.entityId)) {
          edges.push({ from: page.id, to: link.entityId, type: 'part-of' });
        }
      }
    }

    // A fact on a page the map could not draw keeps no edge to it.
    const drawn = new Set(nodes.map((node) => node.id));

    const runIds = [
      ...new Set(uses.map((use) => use.agentRunId as string)),
    ].slice(0, MAX_MAP_RUNS);
    const runs = runIds.length
      ? await this.prisma.agentRun.findMany({
          where: { id: { in: runIds }, workspaceId },
          select: {
            id: true,
            issue: {
              select: { number: true, team: { select: { identifier: true } } },
            },
            entrySignals: {
              where: { createdAt: { lte: until } },
              select: { kind: true },
            },
          },
        })
      : [];

    for (const run of runs) {
      const kinds = run.entrySignals.map((signal) => signal.kind);
      const key = run.issue
        ? `${run.issue.team.identifier}-${run.issue.number}`
        : null;

      add({
        id: `run:${run.id}`,
        type: 'run',
        label: key ? `A run on ${key}` : 'A run',
        issueKey: key,
        outcome: kinds.includes(PageEntrySignalKind.HARMFUL)
          ? 'wrong'
          : kinds.includes(PageEntrySignalKind.HELPFUL)
            ? 'well'
            : null,
      });
    }

    const drawnRuns = new Set(runs.map((run) => run.id));
    const given = new Set<string>();

    for (const use of uses) {
      const key = `${use.entryId}|${use.agentRunId}`;

      if (drawnRuns.has(use.agentRunId as string) && !given.has(key)) {
        given.add(key);
        edges.push({
          from: use.entryId,
          to: `run:${use.agentRunId}`,
          type: 'given',
        });
      }
    }

    return {
      asOf: until,
      since: first?.createdAt ?? null,
      nodes,
      edges: edges.filter(
        (edge) =>
          drawn.has(edge.from) && (drawn.has(edge.to) || seen.has(edge.to)),
      ),
      products,
      marks: marks.sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
      ),
      moduleUse: this.moduleUse(entries, uses, runs),
      factUse: [
        ...countBy(
          uses,
          (use) => use.entryId,
          (use) => use.agentRunId,
        ),
      ].map(([entryId, runsOf]) => ({ entryId, runs: runsOf })),
    };
  }

  private moduleUse(
    entries: Array<{ id: string; moduleIds: string[] }>,
    uses: Array<{ entryId: string; agentRunId: string | null }>,
    runs: Array<{
      id: string;
      entrySignals: Array<{ kind: PageEntrySignalKind }>;
    }>,
  ): KnowledgeMap['moduleUse'] {
    const modulesOf = new Map(
      entries.map((entry) => [entry.id, entry.moduleIds]),
    );
    const outcome = new Map(
      runs.map((run) => {
        const kinds = run.entrySignals.map((signal) => signal.kind);

        return [
          run.id,
          kinds.includes(PageEntrySignalKind.HARMFUL)
            ? 'wrong'
            : kinds.includes(PageEntrySignalKind.HELPFUL)
              ? 'well'
              : null,
        ];
      }),
    );
    const byModule = new Map<string, { given: number; runs: Set<string> }>();

    for (const use of uses) {
      for (const moduleId of modulesOf.get(use.entryId) ?? []) {
        const row = byModule.get(moduleId) ?? { given: 0, runs: new Set() };
        row.given += 1;
        row.runs.add(use.agentRunId as string);
        byModule.set(moduleId, row);
      }
    }

    return [...byModule].map(([moduleId, row]) => ({
      moduleId,
      given: row.given,
      runs: row.runs.size,
      well: [...row.runs].filter((id) => outcome.get(id) === 'well').length,
      wrong: [...row.runs].filter((id) => outcome.get(id) === 'wrong').length,
    }));
  }

  /** The runs whose packs were traced, newest first. */
  async tracedRuns(workspaceId: string): Promise<KnowledgeTracedRun[]> {
    const traces = await this.prisma.knowledgePackTrace.findMany({
      where: {
        workspaceId,
        agentRunId: { not: null },
        agentRun: { workspaceId },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        agentRunId: true,
        createdAt: true,
        arm: true,
        candidates: true,
        agentRun: {
          select: {
            issue: {
              select: {
                title: true,
                number: true,
                team: { select: { identifier: true } },
              },
            },
          },
        },
      },
    });

    return traces.map((trace) => ({
      id: trace.agentRunId as string,
      createdAt: trace.createdAt,
      issueKey: trace.agentRun?.issue
        ? `${trace.agentRun.issue.team.identifier}-${trace.agentRun.issue.number}`
        : null,
      issueTitle: trace.agentRun?.issue?.title ?? null,
      arm: trace.arm,
      given: candidatesOf(trace.candidates).filter((row) => row.given).length,
    }));
  }

  /**
   * Why one run got what it got: every fact its pack considered, why each
   * was given or dropped, what the run's outcome said about each, and the
   * model calls the run caused.
   *
   * A run gets a pack when it starts, and one more each time its agent
   * calls load_context. `traceId` picks one of those; the pack it got at
   * the start is the default.
   */
  async trace(
    workspaceId: string,
    runId: string,
    traceId?: string,
  ): Promise<KnowledgeRunTrace> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, workspaceId, deleted: null },
      select: {
        id: true,
        issueId: true,
        agentUserId: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        knowledgeArm: true,
        pullRequestOutcome: true,
        issue: {
          select: {
            title: true,
            number: true,
            team: { select: { identifier: true } },
          },
        },
        iterations: {
          orderBy: { index: 'desc' },
          take: 1,
          select: { verificationPassed: true, accepted: true },
        },
        packTrace: true,
        entrySignals: {
          select: { entryId: true, kind: true, evidence: true },
        },
      },
    });

    if (!run) {
      throw new NotFoundException({
        message: 'No such run in this workspace.',
      });
    }

    const agent = await this.prisma.user.findUnique({
      where: { id: run.agentUserId },
      select: { fullname: true, username: true },
    });

    // The packs its agent loaded while the run was going.
    const loaded = await this.prisma.knowledgePackTrace.findMany({
      where: {
        workspaceId,
        via: 'LOAD_CONTEXT',
        userId: run.agentUserId,
        createdAt: {
          gte: run.startedAt ?? run.createdAt,
          ...(run.finishedAt ? { lte: run.finishedAt } : {}),
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const packs = [...(run.packTrace ? [run.packTrace] : []), ...loaded];
    const trace =
      packs.find((pack) => pack.id === traceId) ?? run.packTrace ?? null;
    const candidates = candidatesOf(trace?.candidates);
    const [entries, modules] = await Promise.all([
      this.prisma.pageEntry.findMany({
        where: {
          id: { in: candidates.map((candidate) => candidate.entryId) },
          workspaceId,
        },
        select: {
          id: true,
          content: true,
          kind: true,
          scope: true,
          moduleIds: true,
          citations: { select: { checkedAt: true } },
        },
      }),
      this.prisma.module.findMany({
        where: {
          workspaceId,
          id: {
            in: [
              ...(trace?.seedModuleIds ?? []),
              ...(trace?.neighbourModuleIds ?? []),
            ],
          },
        },
        select: { id: true, name: true },
      }),
    ]);
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const moduleById = new Map(modules.map((module) => [module.id, module]));
    const afterOf = (entryId: string) => {
      const kinds = run.entrySignals
        .filter((signal) => signal.entryId === entryId)
        .map((signal) => signal.kind);

      return kinds.includes(PageEntrySignalKind.HARMFUL)
        ? 'wrong'
        : kinds.includes(PageEntrySignalKind.HELPFUL)
          ? 'well'
          : null;
    };

    const harmful = run.entrySignals.filter(
      (signal) => signal.kind === PageEntrySignalKind.HARMFUL,
    );

    return {
      run: {
        id: run.id,
        issueId: run.issueId,
        issueKey: run.issue
          ? `${run.issue.team.identifier}-${run.issue.number}`
          : null,
        issueTitle: run.issue?.title ?? null,
        agentName: agent?.fullname ?? agent?.username ?? null,
        status: run.status,
        startedAt: run.startedAt,
        createdAt: run.createdAt,
        arm: run.knowledgeArm,
      },
      packs: packs.map((pack) => ({
        id: pack.id,
        via: pack.via,
        createdAt: pack.createdAt,
        query: pack.query,
        given: candidatesOf(pack.candidates).filter((row) => row.given).length,
      })),
      trace: trace
        ? {
            id: trace.id,
            via: trace.via,
            createdAt: trace.createdAt,
            query: trace.query,
            seedModules: trace.seedModuleIds
              .map((id) => moduleById.get(id))
              .filter((module): module is { id: string; name: string } =>
                Boolean(module),
              ),
            neighbourModules: trace.neighbourModuleIds
              .map((id) => moduleById.get(id))
              .filter((module): module is { id: string; name: string } =>
                Boolean(module),
              ),
            topK: trace.topK,
            tokenBudget: trace.tokenBudget,
            tokensGiven: trace.tokensGiven,
            searchFailed: trace.searchFailed,
            rows: candidates.map((candidate) => {
              const entry = entryById.get(candidate.entryId);
              const checked = (entry?.citations ?? [])
                .map((citation) => citation.checkedAt)
                .filter((at): at is Date => Boolean(at))
                .sort((a, b) => b.getTime() - a.getTime())[0];
              const firstModule = entry?.moduleIds
                .map((id) => moduleById.get(id)?.name)
                .find(Boolean);

              return {
                ...candidate,
                content: entry?.content ?? 'A fact that was deleted since',
                kind: entry?.kind ?? 'FACT',
                where: firstModule ?? entry?.scope ?? null,
                checkedAt: checked ?? null,
                after: candidate.given ? afterOf(candidate.entryId) : null,
              };
            }),
          }
        : null,
      after: {
        checks: run.iterations[0]?.verificationPassed ?? null,
        review: run.iterations[0]?.accepted ?? null,
        pullRequest: run.pullRequestOutcome,
      },
      rechecks: harmful.map((signal) => ({
        entryId: signal.entryId,
        order:
          candidates.find((candidate) => candidate.entryId === signal.entryId)
            ?.order ?? null,
        evidence: signal.evidence,
      })),
      modelCalls: await this.modelCalls(
        workspaceId,
        run,
        harmful.map((signal) => signal.entryId),
      ),
    };
  }

  /**
   * The model calls a run caused: the triage of the facts its agent wrote
   * while it ran, and the re-check of each fact its outcome put in doubt.
   * Model calls are not stored one by one, so these are read from the
   * decisions and job runs that record which models they used.
   */
  private async modelCalls(
    workspaceId: string,
    run: {
      agentUserId: string;
      startedAt: Date | null;
      finishedAt: Date | null;
      createdAt: Date;
    },
    rechecked: string[],
  ): Promise<KnowledgeRunTrace['modelCalls']> {
    const from = run.startedAt ?? run.createdAt;
    const to = run.finishedAt ?? new Date();
    const [decisions, rechecks] = await Promise.all([
      this.prisma.knowledgeTriageDecision.findMany({
        where: {
          workspaceId,
          entry: {
            workspaceId,
            sourceUserId: run.agentUserId,
            createdAt: { gte: from, lte: to },
          },
        },
        select: { entryId: true, models: true },
      }),
      rechecked.length
        ? this.prisma.knowledgeJobRun.count({
            where: {
              job: RECHECK_ENTRY_JOB,
              subjectId: { in: rechecked },
              startedAt: { gte: from },
            },
          })
        : Promise.resolve(0),
    ]);

    const judged = decisions.filter((decision) => decision.models.length > 0);
    const calls: KnowledgeRunTrace['modelCalls'] = [];

    if (decisions.length) {
      const facts = new Set(decisions.map((decision) => decision.entryId)).size;
      const models = [
        ...new Set(judged.flatMap((decision) => decision.models)),
      ];

      calls.push({
        purpose: 'triage',
        count: judged.length,
        detail: `${decisions.length} decision${decisions.length === 1 ? '' : 's'} about the ${facts} fact${facts === 1 ? '' : 's'} it wrote${
          models.length ? `, with ${models.join(', ')}` : ', by rule alone'
        }`,
      });
    }

    if (rechecks) {
      calls.push({
        purpose: 'citation.judge',
        count: rechecks,
        detail: `the re-check of ${rechecked.length} fact${rechecked.length === 1 ? '' : 's'} the run went wrong with`,
      });
    }

    return calls;
  }
}

/**
 * κ over every decision type that acts, from the verdicts summed across
 * them, each audited decision weighted for those it was drawn from.
 */
function agreementStat(report: {
  kappaFloor: number;
  types: Array<{
    decision: string;
    kappa: number | null;
    backedOff: boolean;
    weighted: {
      both: number;
      triageOnly: number;
      personOnly: number;
      neither: number;
    };
  }>;
}): KnowledgeGardenerStat {
  const acting = report.types.filter((type) => type.decision !== 'ESCALATE');
  const cells = acting.reduce(
    (sum, type) => ({
      both: sum.both + type.weighted.both,
      triageOnly: sum.triageOnly + type.weighted.triageOnly,
      personOnly: sum.personOnly + type.weighted.personOnly,
      neither: sum.neither + type.weighted.neither,
    }),
    { both: 0, triageOnly: 0, personOnly: 0, neither: 0 },
  );
  const total =
    cells.both + cells.triageOnly + cells.personOnly + cells.neither;
  const paused = acting.filter((type) => type.backedOff);
  const alone = acting.length - paused.length;
  const note = [
    `${alone} decision type${alone === 1 ? '' : 's'} act${alone === 1 ? 's' : ''} alone.`,
    ...paused.map(
      (type) =>
        `${capitalize(DECISION_LABELS[type.decision as KnowledgeTriageDecisionType])} paused at κ ${
          type.kappa === null ? '–' : type.kappa.toFixed(2)
        }.`,
    ),
  ].join(' ');

  if (total === 0) {
    return { value: null, tone: 'people', note: `No verdicts yet. ${note}` };
  }

  const observed = (cells.both + cells.neither) / total;
  const expected =
    ((cells.both + cells.triageOnly) * (cells.both + cells.personOnly) +
      (cells.personOnly + cells.neither) * (cells.triageOnly + cells.neither)) /
    (total * total);
  const kappa = expected === 1 ? null : (observed - expected) / (1 - expected);

  return {
    value: kappa === null ? null : `κ ${kappa.toFixed(2)}`,
    tone: kappa !== null && kappa < report.kappaFloor ? 'warn' : 'people',
    note,
  };
}

/** When a fact left use, as far as the rows that record it say. */
function retiredTime(entry: {
  status: PageEntryStatus;
  updatedAt: Date;
  maintenance: Array<{ createdAt: Date; reversedAt: Date | null }>;
  triageDecisions: Array<{
    decision: KnowledgeTriageDecisionType;
    createdAt: Date;
  }>;
}): Date | null {
  if (!RETIRED.includes(entry.status)) {
    return null;
  }

  const times = [
    ...entry.maintenance
      .filter((row) => !row.reversedAt)
      .map((row) => row.createdAt),
    ...entry.triageDecisions
      .filter(
        (decision) =>
          decision.decision === 'REJECT' || decision.decision === 'CORROBORATE',
      )
      .map((decision) => decision.createdAt),
  ];

  return times.length
    ? new Date(Math.min(...times.map((time) => time.getTime())))
    : entry.updatedAt;
}

/** Where a fact stood at the end of a day. */
function stateAsOf(
  entry: Parameters<typeof retiredTime>[0] & {
    id: string;
    verifiedAt: Date | null;
    createdAt: Date;
    citations: Parameters<typeof entryTrust>[0]['citations'];
  },
  until: Date,
  today: boolean,
  waitingOnPeople: Set<string>,
): KnowledgeMapFactState {
  const retiredAt = retiredTime(entry);

  if (retiredAt && retiredAt <= until) {
    return 'retired';
  }

  const accepted = entry.triageDecisions.find(
    (decision) => decision.decision === 'AUTO_ACCEPT',
  );
  const acceptedAt =
    entry.verifiedAt ??
    accepted?.createdAt ??
    // Accepted with no record of when: a person wrote it, or accepted it
    // before triage kept decisions.
    (ACCEPTED.includes(entry.status) || retiredAt ? entry.createdAt : null);

  if (!acceptedAt || acceptedAt > until) {
    return today && waitingOnPeople.has(entry.id) ? 'needs-you' : 'waiting';
  }

  // Trust is not dated, so a past day shows the trust the fact has now.
  switch (
    entryTrust({
      status: ACCEPTED.includes(entry.status) ? entry.status : 'STANDING',
      verifiedAt:
        entry.verifiedAt && entry.verifiedAt <= until ? entry.verifiedAt : null,
      citations: entry.citations,
    })
  ) {
    case KnowledgeTrustEnum.HUMAN_VERIFIED:
      return 'people';
    case KnowledgeTrustEnum.GROUNDED:
      return 'code';
    case KnowledgeTrustEnum.OBSERVED:
      return 'observed';
    default:
      return 'unconfirmed';
  }
}

function candidatesOf(value: unknown): KnowledgePackCandidate[] {
  return Array.isArray(value) ? (value as KnowledgePackCandidate[]) : [];
}

/** How many distinct values of `value` each key has. */
function countBy<T>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => string | null,
): Map<string, number> {
  const sets = new Map<string, Set<string>>();

  for (const row of rows) {
    const set = sets.get(key(row)) ?? new Set<string>();
    const found = value(row);
    if (found) {
      set.add(found);
    }
    sets.set(key(row), set);
  }

  return new Map([...sets].map(([id, set]) => [id, set.size]));
}

function endOfDay(day: Date): Date {
  const end = new Date(day);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

/** The first sentence of a fact, cut at a word when it is long. */
export function brief(content: string, max = 90): string {
  const text = content.trim().replace(/\s+/g, ' ');
  const first = (text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text).replace(
    /\.$/,
    '',
  );

  if (first.length <= max) {
    return first;
  }

  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(' ');

  return `${cut.slice(0, space > max / 2 ? space : max)}…`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
