import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KnowledgeTriageDecisionType,
  KnowledgeVerificationState,
  PageEntryMaintenanceAction,
  PageEntryProposalState,
  PageEntryStatus,
  PageProposalState,
  Prisma,
} from '@prisma/client';
import {
  type KnowledgeReviewEntry,
  type KnowledgeReviewItem,
  type KnowledgeReviewQueue,
  KnowledgeReviewReasonEnum,
  PageEntryStatusEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { liveEntryIn } from 'common/page-entry-where';

import { knowledgeSettings } from './knowledge-settings';
import PageEntriesService from './page-entries.service';
import { VERIFIER_PENDING_MS } from './pages.interface';
import { PROPOSAL_SELECT, proposalResponse } from './pages.service';
import { statusLeftBy } from './triage/agreement';
import {
  IN_USE,
  type MaintenanceEvidence,
  proposalSummary,
  reviewReasonOf,
} from './upkeep/maintenance';

const ENTRY_SELECT = {
  id: true,
  pageId: true,
  content: true,
  scope: true,
  kind: true,
  status: true,
  sourceUserId: true,
  createdAt: true,
} as const;

const DECISION_SELECT = {
  id: true,
  entryId: true,
  decision: true,
  reasons: true,
  policy: true,
  mode: true,
  audit: true,
  backedOffFrom: true,
  verdict: true,
} as const;

type Decision = Prisma.KnowledgeTriageDecisionGetPayload<{
  select: typeof DECISION_SELECT;
}>;

/** The most proposed page consolidations the queue lists at once. */
const MAX_PAGE_PROPOSALS = 50;

/**
 * The review queue: what waits on a person, and why.
 *
 * Every entry still in the inbox, as before, with the reasons triage
 * escalated it when it did; beside them, decisions triage acted on that were
 * drawn for audit; entries in use the gardener asks a person to archive;
 * and, apart from the entries, consolidations of pages people write that
 * wait on a person's accepting them. Where triage is off, the queue is the
 * inbox and the proposals, with nothing of triage's added.
 */
@Injectable()
export default class KnowledgeReviewService {
  constructor(
    private prisma: PrismaService,
    private pageEntries: PageEntriesService,
  ) {}

  async queue(
    workspaceId: string,
    options: { pageId?: string; reasons?: KnowledgeReviewReasonEnum[] } = {},
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<KnowledgeReviewQueue> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { preferences: true },
    });
    const settings = knowledgeSettings(workspace?.preferences, env);
    const page: Prisma.PageWhereInput = {
      workspaceId,
      deleted: null,
      ...(options.pageId ? { id: options.pageId } : {}),
    };
    // The entries of the queue: on the page asked for, or, for the whole
    // workspace, on any live page and on no page.
    const onPage: Prisma.PageEntryWhereInput = options.pageId
      ? { pageId: options.pageId, page }
      : liveEntryIn(workspaceId);

    // Not an entry the verifier is looking at: a person sees it once the
    // verifier is done, or once the look has taken too long.
    const looking = new Date(Date.now() - VERIFIER_PENDING_MS);
    const waiting = await this.prisma.pageEntry.findMany({
      where: {
        deleted: null,
        status: PageEntryStatus.PROPOSED,
        ...onPage,
        NOT: {
          verification: {
            is: {
              state: KnowledgeVerificationState.PENDING,
              updatedAt: { gt: looking },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: ENTRY_SELECT,
    });
    const triaged = settings.autoTriage !== 'off';

    // The latest decision about each waiting entry, while no person has
    // given a verdict on it.
    const open = new Map<string, Decision>();

    if (triaged && waiting.length) {
      const decisions = await this.prisma.knowledgeTriageDecision.findMany({
        where: {
          workspaceId,
          entryId: { in: waiting.map((entry) => entry.id) },
        },
        orderBy: { createdAt: 'desc' },
        select: DECISION_SELECT,
      });
      const latest = new Set<string>();

      for (const decision of decisions) {
        if (latest.has(decision.entryId)) {
          continue;
        }

        latest.add(decision.entryId);

        if (decision.verdict === null) {
          open.set(decision.entryId, decision);
        }
      }
    }

    // Audits whose entry is still as the decision left it. One a person has
    // since moved on (decay archived it, a correction superseded it) asks
    // about something no longer there.
    const audits = triaged
      ? (
          await this.prisma.knowledgeTriageDecision.findMany({
            where: {
              workspaceId,
              audit: true,
              verdict: null,
              entry: { deleted: null, ...onPage },
            },
            orderBy: { createdAt: 'desc' },
            select: { ...DECISION_SELECT, entry: { select: ENTRY_SELECT } },
          })
        ).filter(
          (decision) =>
            decision.entry.status === statusLeftBy(decision.decision),
        )
      : [];

    // Proposals about entries still in use, standing or consolidated. One
    // whose entry a person has since moved (archived it by hand, disputed
    // it) asks about nothing.
    const proposals = await this.prisma.pageEntryMaintenance.findMany({
      where: {
        workspaceId,
        action: PageEntryMaintenanceAction.ARCHIVE_PROPOSED,
        proposalState: PageEntryProposalState.OPEN,
        entry: { deleted: null, status: { in: IN_USE }, ...onPage },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reason: true,
        evidence: true,
        issueId: true,
        createdAt: true,
        entry: { select: ENTRY_SELECT },
      },
    });

    // Consolidations of pages people write, waiting on a person.
    const pageProposals = await this.prisma.pageProposal.findMany({
      where: { state: PageProposalState.OPEN, page },
      orderBy: { createdAt: 'desc' },
      take: MAX_PAGE_PROPOSALS,
      select: PROPOSAL_SELECT,
    });

    const all: KnowledgeReviewItem[] = [
      ...waiting.map((entry) => {
        const decision = open.get(entry.id) ?? null;

        // Only an escalation carries reasons: triage escalates exactly when
        // it has one.
        return item(
          entry,
          decision,
          (decision?.reasons ?? []) as unknown as KnowledgeReviewReasonEnum[],
        );
      }),
      ...audits.map((decision) =>
        item(decision.entry, decision, [KnowledgeReviewReasonEnum.AUDIT]),
      ),
      ...proposals.map((proposal): KnowledgeReviewItem => ({
        ...item(proposal.entry, null, [reviewReasonOf(proposal.reason)]),
        proposal: {
          id: proposal.id,
          summary: proposalSummary(
            proposal.reason,
            proposal.evidence as MaintenanceEvidence | null,
          ),
          issueId: proposal.issueId,
          createdAt: proposal.createdAt,
        },
      })),
    ];

    const counts = new Map<KnowledgeReviewReasonEnum, number>();

    for (const { reasons } of all) {
      for (const reason of reasons) {
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
    }

    const wanted = options.reasons?.length ? new Set(options.reasons) : null;

    return {
      autoTriage: settings.autoTriage,
      items: wanted
        ? all.filter(({ reasons }) =>
            reasons.some((reason) => wanted.has(reason)),
          )
        : all,
      reasons: [...counts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      pageProposals: pageProposals.map(proposalResponse),
    };
  }

  /**
   * A person's answer to the gardener's proposal to archive an entry.
   * Accepting archives it through the same change a person makes by hand,
   * with the proposal resolved in the same transaction; declining keeps it in
   * use, and the gardener does not ask again for the same reason within the
   * decay window. A second answer, or one about an entry that has moved on,
   * is refused with 409.
   */
  async resolveProposal(
    workspaceId: string,
    proposalId: string,
    userId: string,
    accept: boolean,
  ) {
    const proposal = await this.prisma.pageEntryMaintenance.findFirst({
      where: {
        id: proposalId,
        workspaceId,
        action: PageEntryMaintenanceAction.ARCHIVE_PROPOSED,
        entry: { deleted: null, ...liveEntryIn(workspaceId) },
      },
      select: {
        id: true,
        entryId: true,
        proposalState: true,
        entry: { select: { status: true } },
      },
    });

    if (!proposal) {
      throw new NotFoundException({
        message: `Proposal ${proposalId} not found`,
      });
    }

    if (proposal.proposalState !== PageEntryProposalState.OPEN) {
      throw new ConflictException({
        message: `This proposal was already answered: ${String(proposal.proposalState).toLowerCase()}.`,
      });
    }

    if (!IN_USE.includes(proposal.entry.status)) {
      throw new ConflictException({
        message:
          `This entry has moved on since the proposal was made (it is now ` +
          `${proposal.entry.status.toLowerCase()}). Act on the entry itself instead.`,
      });
    }

    if (!accept) {
      const { count } = await this.prisma.pageEntryMaintenance.updateMany({
        where: { id: proposal.id, proposalState: PageEntryProposalState.OPEN },
        data: {
          proposalState: PageEntryProposalState.DECLINED,
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      });

      if (count === 0) {
        throw new ConflictException({
          message: 'This proposal was answered by someone else first.',
        });
      }

      return { proposalId: proposal.id, accepted: false };
    }

    try {
      await this.pageEntries.updateEntry(
        proposal.entryId,
        userId,
        { status: PageEntryStatusEnum.ARCHIVED },
        { proposal: proposal.id },
      );
    } catch (error) {
      // Someone else's answer landed between the check above and this one,
      // and this answer was rolled back with its change.
      const now = await this.prisma.pageEntryMaintenance.findFirst({
        where: { id: proposal.id },
        select: { proposalState: true },
      });

      if (now && now.proposalState !== PageEntryProposalState.OPEN) {
        throw new ConflictException({
          message: 'This proposal was answered by someone else first.',
        });
      }

      throw error;
    }

    return { proposalId: proposal.id, accepted: true };
  }

  /**
   * Closes a gap with the fact a person wrote to answer it. The fact must be
   * in use and in the same workspace as the gap. The gap row stays, so a
   * repeat of the question does not open a second issue.
   */
  async answerGap(workspaceId: string, gapId: string, entryId: string) {
    const [gap, entry] = await Promise.all([
      this.prisma.pageKnowledgeGap.findFirst({
        where: { id: gapId, workspaceId },
        select: { id: true },
      }),
      this.prisma.pageEntry.findFirst({
        where: {
          id: entryId,
          deleted: null,
          status: {
            in: [PageEntryStatus.STANDING, PageEntryStatus.CONSOLIDATED],
          },
          ...liveEntryIn(workspaceId),
        },
        select: { id: true },
      }),
    ]);

    if (!gap || !entry) {
      throw new NotFoundException({
        message: gap
          ? `Entry ${entryId} is not in use in this workspace`
          : `Gap ${gapId} not found`,
      });
    }

    return this.prisma.pageKnowledgeGap.update({
      where: { id: gap.id },
      data: { answeredAt: new Date(), answeredByEntryId: entry.id },
      select: { id: true, query: true, answeredAt: true },
    });
  }

  /**
   * A person's answer to an audit. Agreeing keeps what triage did; not
   * agreeing undoes it, through the same change a person would make by
   * hand: an entry accepted without a person is set aside, and one folded
   * into what it repeats or rejected on a policy is put into use. The change
   * records the verdict on the decision, as any person's action on an
   * audited entry still where triage left it does.
   */
  async resolveAudit(
    workspaceId: string,
    decisionId: string,
    userId: string,
    agree: boolean,
  ) {
    const decision = await this.prisma.knowledgeTriageDecision.findFirst({
      where: {
        id: decisionId,
        workspaceId,
        entry: { deleted: null, ...liveEntryIn(workspaceId) },
      },
      select: {
        id: true,
        entryId: true,
        decision: true,
        audit: true,
        verdict: true,
        entry: { select: { status: true } },
      },
    });

    if (!decision) {
      throw new NotFoundException({
        message: `Triage decision ${decisionId} not found`,
      });
    }

    if (!decision.audit) {
      throw new BadRequestException({
        message:
          'That decision was not drawn for audit. Accept, set aside or edit ' +
          'the entry itself instead.',
      });
    }

    if (decision.verdict !== null) {
      throw new ConflictException({
        message: `This audit already has a verdict: ${decision.verdict.toLowerCase()}.`,
      });
    }

    // The queue stops listing an audit once its entry has moved on (decay
    // archived it, a correction superseded it). An answer from a list opened
    // before then would judge, or undo, what something else did.
    if (decision.entry.status !== statusLeftBy(decision.decision)) {
      throw new ConflictException({
        message:
          `This entry has moved on since triage decided it (it is now ` +
          `${decision.entry.status.toLowerCase()}), so the audit is closed. ` +
          'Act on the entry itself instead.',
      });
    }

    const keep =
      decision.decision === KnowledgeTriageDecisionType.AUTO_ACCEPT ||
      decision.decision === KnowledgeTriageDecisionType.PROVISIONAL
        ? agree
        : !agree;
    let entry: Awaited<ReturnType<PageEntriesService['updateEntry']>>;

    try {
      entry = await this.pageEntries.updateEntry(
        decision.entryId,
        userId,
        {
          status: keep
            ? PageEntryStatusEnum.STANDING
            : PageEntryStatusEnum.ARCHIVED,
        },
        { audit: decision.id },
      );
    } catch (error) {
      // Someone else's answer landed between the check above and this one,
      // and this answer was rolled back with its change.
      const now = await this.prisma.knowledgeTriageDecision.findUnique({
        where: { id: decision.id },
        select: { verdict: true },
      });

      if (now?.verdict) {
        throw new ConflictException({
          message: `This audit already has a verdict: ${now.verdict.toLowerCase()}.`,
        });
      }

      throw error;
    }

    return {
      entry,
      decision: await this.prisma.knowledgeTriageDecision.findUnique({
        where: { id: decision.id },
        select: {
          id: true,
          decision: true,
          verdict: true,
          agreed: true,
          verdictAt: true,
        },
      }),
    };
  }
}

function item(
  entry: Prisma.PageEntryGetPayload<{ select: typeof ENTRY_SELECT }>,
  decision: Decision | null,
  reasons: KnowledgeReviewReasonEnum[],
): KnowledgeReviewItem {
  return {
    entry: entry as unknown as KnowledgeReviewEntry,
    decisionId: decision?.id ?? null,
    decision:
      (decision?.decision as unknown as KnowledgeReviewItem['decision']) ??
      null,
    mode: decision?.mode ?? null,
    reasons,
    audit: decision?.audit ?? false,
    policy: decision?.policy ?? null,
    backedOffFrom:
      (decision?.backedOffFrom as unknown as KnowledgeReviewItem['backedOffFrom']) ??
      null,
  };
}
