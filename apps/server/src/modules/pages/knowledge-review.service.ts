import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KnowledgeTriageDecisionType,
  PageEntryStatus,
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

import { knowledgeSettings } from './knowledge-settings';
import PageEntriesService from './page-entries.service';
import { statusLeftBy } from './triage/agreement';

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

/**
 * The review queue: what waits on a person, and why.
 *
 * Every entry still in the inbox, as before, with the reasons triage
 * escalated it when it did; and, beside them, decisions triage acted on that
 * were drawn for audit. Where triage is off, the queue is the inbox alone,
 * with nothing added to it.
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

    const waiting = await this.prisma.pageEntry.findMany({
      where: { deleted: null, status: PageEntryStatus.PROPOSED, page },
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
              entry: { deleted: null, page },
            },
            orderBy: { createdAt: 'desc' },
            select: { ...DECISION_SELECT, entry: { select: ENTRY_SELECT } },
          })
        ).filter(
          (decision) =>
            decision.entry.status === statusLeftBy(decision.decision),
        )
      : [];

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
    };
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
        entry: { deleted: null, page: { workspaceId, deleted: null } },
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
      decision.decision === KnowledgeTriageDecisionType.AUTO_ACCEPT
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
