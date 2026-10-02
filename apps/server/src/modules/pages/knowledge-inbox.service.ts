import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KnowledgeInboxEventType,
  KnowledgeInboxKind,
  KnowledgeTriageDecisionType,
  KnowledgeTriageMode,
  PageEntryRelationType,
  PageEntryStatus,
  Prisma,
} from '@prisma/client';
import {
  type KnowledgeInboxCheck,
  type KnowledgeInboxDetail,
  type KnowledgeInboxItem,
  type KnowledgeInboxList,
  type KnowledgeInboxView,
  type KnowledgeReviewEntry,
  type KnowledgeReviewItem,
  KnowledgeInboxChoiceEnum,
  KnowledgeInboxKindEnum,
  KnowledgeReviewReasonEnum,
  PageEntryKindEnum,
  PageEntryStatusEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { MIN_GAP_ASKS } from './knowledge-overview.service';
import KnowledgeReviewService from './knowledge-review.service';
import PageEntriesService from './page-entries.service';
import { checksOf } from './triage/checks';
import PagesService, {
  PROPOSAL_SELECT,
  proposalResponse,
} from './pages.service';

/** How far back the Done view reaches, and how many items it lists. */
const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DONE_LIMIT = 50;

/** How far back "settled by agents" counts. */
const SETTLED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_COMMENT = 4000;

/** What an item that left the queue without a decision here says. */
export const SETTLED_ELSEWHERE = 'settled outside Needs you';

/** The kinds about a waiting entry. The row keeps the entry id, and the kind can change. */
const WAITING_KINDS = new Set<KnowledgeInboxKind>([
  KnowledgeInboxKind.CONTRADICTION,
  KnowledgeInboxKind.RULE,
  KnowledgeInboxKind.FACT,
]);

const CONTRADICTION_REASONS = new Set<KnowledgeReviewReasonEnum>([
  KnowledgeReviewReasonEnum.CONTRADICTS_VERIFIED,
  KnowledgeReviewReasonEnum.CONTRADICTS_LOCKED,
  KnowledgeReviewReasonEnum.CITATION_CONTRADICTED,
]);

const RULE_KINDS = new Set<string>([
  PageEntryKindEnum.DECISION,
  PageEntryKindEnum.CONVENTION,
]);

/** The two answers each kind takes, and how each reads once given. */
export const INBOX_CHOICES: Record<
  KnowledgeInboxKind,
  Partial<Record<KnowledgeInboxChoiceEnum, string>>
> = {
  CONTRADICTION: {
    USE_NEW: 'used the new fact and retired the old one',
    KEEP_OLD: 'kept the old fact',
  },
  RULE: { USE: 'put it in use', SET_ASIDE: 'set it aside' },
  FACT: { USE: 'put it in use', SET_ASIDE: 'set it aside' },
  AUDIT: { AGREE: 'agreed with triage', UNDO: 'undid what triage did' },
  ARCHIVE: { RETIRE: 'retired it', KEEP: 'kept it in use' },
  REWRITE: {
    ACCEPT: 'accepted the rewrite',
    DECLINE: 'kept the page as it was',
  },
  GAP: { ANSWER: 'answered it' },
};

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

const ROW_SELECT = {
  id: true,
  kind: true,
  subjectId: true,
  entryId: true,
  raisedAt: true,
  assigneeId: true,
  doneAt: true,
  doneById: true,
  resolution: true,
} as const;

type Row = Prisma.KnowledgeInboxItemGetPayload<{ select: typeof ROW_SELECT }>;

/** Something that waits on a person now, before it is a row. */
interface Subject {
  kind: KnowledgeInboxKind;
  subjectId: string;
  entryId: string | null;
  raisedAt: Date;
  view: Omit<
    KnowledgeInboxItem,
    | 'id'
    | 'kind'
    | 'subjectId'
    | 'raisedAt'
    | 'assigneeId'
    | 'doneAt'
    | 'doneById'
    | 'resolution'
    | 'pageTitle'
  >;
}

/**
 * The key that matches a subject to its row. A waiting entry keeps one row
 * whatever it is classified as, so a fact that becomes a contradiction keeps
 * its assignee and its thread.
 */
function keyOf(kind: KnowledgeInboxKind, subjectId: string) {
  return WAITING_KINDS.has(kind)
    ? `entry:${subjectId}`
    : `${kind}:${subjectId}`;
}

/** What a waiting entry asks a person, from what it is and why it waits. */
export function classify(
  entry: Pick<KnowledgeReviewEntry, 'kind'>,
  reasons: KnowledgeReviewReasonEnum[],
): KnowledgeInboxKind {
  if (reasons.some((reason) => CONTRADICTION_REASONS.has(reason))) {
    return KnowledgeInboxKind.CONTRADICTION;
  }

  if (RULE_KINDS.has(entry.kind)) {
    return KnowledgeInboxKind.RULE;
  }

  return KnowledgeInboxKind.FACT;
}

/**
 * Needs you: one inbox, shared by the workspace, for every knowledge decision
 * that waits on a person.
 *
 * The review queue says what waits. This service gives each of those
 * subjects a row, so that a person can be put on it and people can talk
 * about it, and it keeps the rows in step with the queue each time it is
 * read: a new subject gets a row, and a row whose subject left the queue
 * without a decision here is closed as settled.
 */
@Injectable()
export default class KnowledgeInboxService {
  constructor(
    private prisma: PrismaService,
    private review: KnowledgeReviewService,
    private pageEntries: PageEntriesService,
    private pages: PagesService,
  ) {}

  async list(
    workspaceId: string,
    userId: string,
    options: { view?: KnowledgeInboxView; pageId?: string } = {},
  ): Promise<KnowledgeInboxList> {
    const subjects = await this.subjects(workspaceId);
    await this.reconcile(workspaceId, subjects);

    const [open, done, settledByAgents] = await Promise.all([
      this.prisma.knowledgeInboxItem.findMany({
        where: { workspaceId, doneAt: null },
        orderBy: { raisedAt: 'desc' },
        select: ROW_SELECT,
      }),
      this.prisma.knowledgeInboxItem.findMany({
        where: {
          workspaceId,
          doneAt: { gte: new Date(Date.now() - DONE_WINDOW_MS) },
        },
        orderBy: { doneAt: 'desc' },
        take: DONE_LIMIT,
        select: ROW_SELECT,
      }),
      this.prisma.knowledgeTriageDecision.count({
        where: {
          workspaceId,
          mode: KnowledgeTriageMode.ON,
          applied: true,
          decision: { not: KnowledgeTriageDecisionType.ESCALATE },
          createdAt: { gte: new Date(Date.now() - SETTLED_WINDOW_MS) },
        },
      }),
    ]);

    const onPage = (item: KnowledgeInboxItem) =>
      !options.pageId || item.pageId === options.pageId;
    const openItems = (await this.views(workspaceId, open, subjects)).filter(
      onPage,
    );
    const doneItems = (await this.views(workspaceId, done, subjects)).filter(
      onPage,
    );

    const mine = openItems.filter((item) => item.assigneeId === userId);
    const unassigned = openItems.filter((item) => !item.assigneeId);
    const assignees = new Map<string, number>();

    for (const item of openItems) {
      if (item.assigneeId) {
        assignees.set(
          item.assigneeId,
          (assignees.get(item.assigneeId) ?? 0) + 1,
        );
      }
    }

    const view = options.view ?? 'open';

    return {
      items:
        view === 'done'
          ? doneItems
          : view === 'mine'
            ? mine
            : view === 'unassigned'
              ? unassigned
              : openItems,
      counts: {
        open: openItems.length,
        mine: mine.length,
        unassigned: unassigned.length,
        done: doneItems.length,
      },
      assignees: [...assignees.entries()]
        .map(([assigneeId, count]) => ({ userId: assigneeId, count }))
        .sort((a, b) => b.count - a.count),
      settledByAgents,
    };
  }

  /** One item, with its thread and what deciding it needs. */
  async detail(workspaceId: string, id: string): Promise<KnowledgeInboxDetail> {
    const subjects = await this.subjects(workspaceId);
    await this.reconcile(workspaceId, subjects);

    const row = await this.row(workspaceId, id);
    const [item] = await this.views(workspaceId, [row], subjects);
    const events = await this.prisma.knowledgeInboxEvent.findMany({
      where: { itemId: row.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        createdAt: true,
        type: true,
        userId: true,
        assigneeId: true,
        body: true,
      },
    });

    const [fact] = row.entryId
      ? await this.pageEntries.getEntries(workspaceId, { ids: [row.entryId] })
      : [];

    let contradicts: KnowledgeInboxDetail['contradicts'] = [];

    if (row.entryId && row.kind === KnowledgeInboxKind.CONTRADICTION) {
      const relations = await this.prisma.pageEntryRelation.findMany({
        where: { fromId: row.entryId, type: PageEntryRelationType.CONTRADICTS },
        select: { toId: true },
      });

      contradicts = relations.length
        ? await this.pageEntries.getEntries(workspaceId, {
            ids: relations.map((relation) => relation.toId),
          })
        : [];
    }

    const rewrite =
      row.kind === KnowledgeInboxKind.REWRITE
        ? await this.prisma.pageProposal.findFirst({
            where: { id: row.subjectId, page: { workspaceId } },
            select: PROPOSAL_SELECT,
          })
        : null;

    return {
      item,
      events: events as KnowledgeInboxDetail['events'],
      fact: fact ?? null,
      contradicts,
      rewrite: rewrite ? proposalResponse(rewrite) : null,
      checks:
        row.entryId && WAITING_KINDS.has(row.kind) && !row.doneAt
          ? await this.checksOf(row.entryId)
          : [],
    };
  }

  /**
   * What the acceptance checks of an entry's last triage said, so a person
   * reads why it waits rather than only that the checks did not agree.
   */
  private async checksOf(entryId: string): Promise<KnowledgeInboxCheck[]> {
    const decision = await this.prisma.knowledgeTriageDecision.findFirst({
      where: { entryId },
      orderBy: { createdAt: 'desc' },
      select: { outputs: true },
    });

    return checksOf(decision?.outputs);
  }

  /** Puts a person on an item, or, with null, takes everyone off it. */
  async assign(
    workspaceId: string,
    userId: string,
    id: string,
    assigneeId: string | null,
  ) {
    const row = await this.row(workspaceId, id);

    if (assigneeId) {
      const member = await this.prisma.usersOnWorkspaces.findFirst({
        where: { workspaceId, userId: assigneeId },
        select: { id: true },
      });

      if (!member) {
        throw new BadRequestException({
          message: `User ${assigneeId} is not a member of this workspace`,
        });
      }
    }

    await this.prisma.$transaction([
      this.prisma.knowledgeInboxItem.update({
        where: { id: row.id },
        data: { assigneeId },
      }),
      this.prisma.knowledgeInboxEvent.create({
        data: {
          itemId: row.id,
          type: KnowledgeInboxEventType.ASSIGNED,
          userId,
          assigneeId,
        },
      }),
    ]);

    return { id: row.id, assigneeId };
  }

  async comment(workspaceId: string, userId: string, id: string, body: string) {
    const text = body.trim();

    if (!text) {
      throw new BadRequestException({ message: 'A comment needs some text' });
    }

    const row = await this.row(workspaceId, id);

    return this.prisma.knowledgeInboxEvent.create({
      data: {
        itemId: row.id,
        type: KnowledgeInboxEventType.COMMENTED,
        userId,
        body: text.slice(0, MAX_COMMENT),
      },
      select: {
        id: true,
        createdAt: true,
        type: true,
        userId: true,
        assigneeId: true,
        body: true,
      },
    });
  }

  /**
   * A person's decision about an item, made through the same change the
   * review routes make, so it counts as a verdict on triage where triage
   * decided. The item is then done, with the decision in its thread.
   */
  async decide(
    workspaceId: string,
    userId: string,
    id: string,
    choice: KnowledgeInboxChoiceEnum,
    entryId?: string,
  ) {
    const subjects = await this.subjects(workspaceId);
    await this.reconcile(workspaceId, subjects);

    const row = await this.row(workspaceId, id);

    if (row.doneAt) {
      throw new ConflictException({
        message: `This was already decided: ${row.resolution ?? 'done'}.`,
      });
    }

    const resolution = INBOX_CHOICES[row.kind][choice];

    if (!resolution) {
      throw new BadRequestException({
        message:
          `${choice} is not an answer to ${row.kind.toLowerCase()}. ` +
          `Choose one of ${Object.keys(INBOX_CHOICES[row.kind]).join(', ')}.`,
      });
    }

    const subject = subjects.find(
      (candidate) =>
        keyOf(candidate.kind, candidate.subjectId) ===
        keyOf(row.kind, row.subjectId),
    );

    switch (row.kind) {
      case KnowledgeInboxKind.FACT:
      case KnowledgeInboxKind.RULE:
        await this.setStatus(
          userId,
          [row.subjectId],
          choice === KnowledgeInboxChoiceEnum.USE
            ? PageEntryStatusEnum.STANDING
            : PageEntryStatusEnum.ARCHIVED,
        );
        break;

      case KnowledgeInboxKind.CONTRADICTION: {
        if (choice === KnowledgeInboxChoiceEnum.KEEP_OLD) {
          await this.setStatus(
            userId,
            [row.subjectId],
            PageEntryStatusEnum.ARCHIVED,
          );
          break;
        }

        await this.setStatus(
          userId,
          [row.subjectId],
          PageEntryStatusEnum.STANDING,
        );

        const old = await this.prisma.pageEntryRelation.findMany({
          where: {
            fromId: row.subjectId,
            type: PageEntryRelationType.CONTRADICTS,
            to: {
              deleted: null,
              status: {
                in: [PageEntryStatus.STANDING, PageEntryStatus.CONSOLIDATED],
              },
            },
          },
          select: { toId: true },
        });

        if (old.length) {
          await this.setStatus(
            userId,
            old.map((relation) => relation.toId),
            PageEntryStatusEnum.ARCHIVED,
          );
        }
        break;
      }

      case KnowledgeInboxKind.AUDIT:
        await this.review.resolveAudit(
          workspaceId,
          row.subjectId,
          userId,
          choice === KnowledgeInboxChoiceEnum.AGREE,
        );
        break;

      case KnowledgeInboxKind.ARCHIVE:
        await this.review.resolveProposal(
          workspaceId,
          row.subjectId,
          userId,
          choice === KnowledgeInboxChoiceEnum.RETIRE,
        );
        break;

      case KnowledgeInboxKind.REWRITE: {
        const pageId = subject?.view.pageId;

        if (!pageId) {
          throw new ConflictException({
            message: 'This rewrite was already answered on its page.',
          });
        }

        if (choice === KnowledgeInboxChoiceEnum.ACCEPT) {
          await this.pages.acceptProposal(pageId, row.subjectId, userId);
        } else {
          await this.pages.declineProposal(pageId, row.subjectId, userId);
        }
        break;
      }

      case KnowledgeInboxKind.GAP:
        if (!entryId) {
          throw new BadRequestException({
            message: 'Name the fact that answers the question: entryId.',
          });
        }

        await this.review.answerGap(workspaceId, row.subjectId, entryId);
        break;
    }

    const doneAt = new Date();

    await this.prisma.$transaction([
      this.prisma.knowledgeInboxItem.update({
        where: { id: row.id },
        data: { doneAt, doneById: userId, resolution },
      }),
      this.prisma.knowledgeInboxEvent.create({
        data: {
          itemId: row.id,
          type: KnowledgeInboxEventType.DECIDED,
          userId,
          body: resolution,
        },
      }),
    ]);

    return { id: row.id, doneAt, doneById: userId, resolution };
  }

  // ----------------------------------------------------------------- inside

  private async row(workspaceId: string, id: string): Promise<Row> {
    const row = await this.prisma.knowledgeInboxItem.findFirst({
      where: { id, workspaceId },
      select: ROW_SELECT,
    });

    if (!row) {
      throw new NotFoundException({ message: `Item ${id} not found` });
    }

    return row;
  }

  /**
   * Sets the status of entries as a person does on the page, so a waiting
   * entry's open triage decision gets its verdict and a correction settles
   * what it supersedes.
   */
  private async setStatus(
    userId: string,
    entryIds: string[],
    status: PageEntryStatusEnum,
  ) {
    for (const entryId of entryIds) {
      await this.pageEntries.updateEntry(entryId, userId, { status });
    }
  }

  /** Everything that waits on a person now, from the review queue and the open gaps. */
  async subjects(workspaceId: string): Promise<Subject[]> {
    const [queue, gaps] = await Promise.all([
      this.review.queue(workspaceId),
      this.prisma.pageKnowledgeGap.findMany({
        where: { workspaceId, answeredAt: null, count: { gte: MIN_GAP_ASKS } },
        orderBy: { count: 'desc' },
        select: { id: true, query: true, count: true, createdAt: true },
      }),
    ]);

    const auditIds = queue.items
      .filter((item) => item.audit && item.decisionId)
      .map((item) => item.decisionId as string);
    const decided = new Map(
      auditIds.length
        ? (
            await this.prisma.knowledgeTriageDecision.findMany({
              where: { id: { in: auditIds } },
              select: { id: true, createdAt: true },
            })
          ).map((decision) => [decision.id, decision.createdAt])
        : [],
    );

    const fromEntry = (
      item: KnowledgeReviewItem,
    ): Omit<Subject['view'], 'raisedBy'> => ({
      entry: item.entry,
      pageId: item.entry.pageId,
      reasons: item.reasons,
      decision: null,
      proposal: null,
      gap: null,
    });

    const subjects: Subject[] = queue.items.map((item): Subject => {
      if (item.proposal) {
        return {
          kind: KnowledgeInboxKind.ARCHIVE,
          subjectId: item.proposal.id,
          entryId: item.entry.id,
          raisedAt: new Date(item.proposal.createdAt),
          view: {
            ...fromEntry(item),
            raisedBy: 'gardener',
            proposal: { id: item.proposal.id, summary: item.proposal.summary },
          },
        };
      }

      if (item.audit && item.decisionId) {
        return {
          kind: KnowledgeInboxKind.AUDIT,
          subjectId: item.decisionId,
          entryId: item.entry.id,
          raisedAt:
            decided.get(item.decisionId) ?? new Date(item.entry.createdAt),
          view: {
            ...fromEntry(item),
            raisedBy: 'triage',
            decision: item.decision
              ? {
                  id: item.decisionId,
                  decision: item.decision,
                  policy: item.policy,
                }
              : null,
          },
        };
      }

      return {
        kind: classify(item.entry, item.reasons),
        subjectId: item.entry.id,
        entryId: item.entry.id,
        raisedAt: new Date(item.entry.createdAt),
        view: {
          ...fromEntry(item),
          raisedBy: item.decisionId ? 'triage' : 'an agent',
        },
      };
    });

    for (const proposal of queue.pageProposals) {
      subjects.push({
        kind: KnowledgeInboxKind.REWRITE,
        subjectId: proposal.id,
        entryId: null,
        raisedAt: new Date(proposal.createdAt),
        view: {
          entry: null,
          pageId: proposal.pageId,
          reasons: [],
          raisedBy: 'gardener',
          decision: null,
          proposal: {
            id: proposal.id,
            summary: `Folds ${proposal.entryIds.length} ${
              proposal.entryIds.length === 1 ? 'fact' : 'facts'
            } into the page`,
          },
          gap: null,
        },
      });
    }

    for (const gap of gaps) {
      subjects.push({
        kind: KnowledgeInboxKind.GAP,
        subjectId: gap.id,
        entryId: null,
        raisedAt: gap.createdAt,
        view: {
          entry: null,
          pageId: null,
          reasons: [],
          raisedBy: 'agents',
          decision: null,
          proposal: null,
          gap: { query: gap.query, count: gap.count },
        },
      });
    }

    return subjects;
  }

  /**
   * Brings the rows in step with the subjects: a row for each new subject,
   * a done row reopened when its subject waits again, and an open row
   * closed as settled when its subject is gone.
   */
  async reconcile(workspaceId: string, subjects: Subject[]) {
    const live = new Map(
      subjects.map((subject) => [
        keyOf(subject.kind, subject.subjectId),
        subject,
      ]),
    );
    const rows = await this.prisma.knowledgeInboxItem.findMany({
      where: {
        workspaceId,
        OR: [
          { doneAt: null },
          { subjectId: { in: subjects.map((subject) => subject.subjectId) } },
        ],
      },
      select: ROW_SELECT,
    });
    const byKey = new Map<string, Row>();

    for (const row of rows) {
      const key = keyOf(row.kind, row.subjectId);
      const held = byKey.get(key);

      // Prefer the open row where a subject has two.
      if (!held || (held.doneAt && !row.doneAt)) {
        byKey.set(key, row);
      }
    }

    const missing: Prisma.KnowledgeInboxItemCreateManyInput[] = [];

    for (const [key, subject] of live) {
      const row = byKey.get(key);

      if (!row) {
        missing.push({
          workspaceId,
          kind: subject.kind,
          subjectId: subject.subjectId,
          entryId: subject.entryId,
          raisedAt: subject.raisedAt,
        });
        continue;
      }

      if (row.doneAt || row.kind !== subject.kind) {
        await this.prisma.knowledgeInboxItem.update({
          where: { id: row.id },
          data: {
            kind: subject.kind,
            ...(row.doneAt
              ? { doneAt: null, doneById: null, resolution: null }
              : {}),
          },
        });
      }
    }

    if (missing.length) {
      await this.prisma.knowledgeInboxItem.createMany({
        data: missing,
        skipDuplicates: true,
      });
    }

    for (const row of rows) {
      if (row.doneAt || live.has(keyOf(row.kind, row.subjectId))) {
        continue;
      }

      // Only the call that closes it writes the event, when two lists race.
      const { count } = await this.prisma.knowledgeInboxItem.updateMany({
        where: { id: row.id, doneAt: null },
        data: { doneAt: new Date(), resolution: SETTLED_ELSEWHERE },
      });

      if (count) {
        await this.prisma.knowledgeInboxEvent.create({
          data: {
            itemId: row.id,
            type: KnowledgeInboxEventType.SETTLED,
            body: SETTLED_ELSEWHERE,
          },
        });
      }
    }
  }

  /** The rows as the inbox shows them, from their subject when it still waits. */
  private async views(
    workspaceId: string,
    rows: Row[],
    subjects: Subject[],
  ): Promise<KnowledgeInboxItem[]> {
    const live = new Map(
      subjects.map((subject) => [
        keyOf(subject.kind, subject.subjectId),
        subject,
      ]),
    );
    const gone = rows.filter(
      (row) => !live.has(keyOf(row.kind, row.subjectId)),
    );

    // A row whose subject is gone is shown from what is left of it.
    const entryIds = gone.flatMap((row) => (row.entryId ? [row.entryId] : []));
    const proposalIds = gone
      .filter((row) => row.kind === KnowledgeInboxKind.REWRITE)
      .map((row) => row.subjectId);
    const gapIds = gone
      .filter((row) => row.kind === KnowledgeInboxKind.GAP)
      .map((row) => row.subjectId);

    const [entries, proposals, gaps] = await Promise.all([
      entryIds.length
        ? this.prisma.pageEntry.findMany({
            where: { id: { in: entryIds } },
            select: ENTRY_SELECT,
          })
        : [],
      proposalIds.length
        ? this.prisma.pageProposal.findMany({
            where: { id: { in: proposalIds }, page: { workspaceId } },
            select: { id: true, pageId: true, entryIds: true },
          })
        : [],
      gapIds.length
        ? this.prisma.pageKnowledgeGap.findMany({
            where: { id: { in: gapIds }, workspaceId },
            select: { id: true, query: true, count: true },
          })
        : [],
    ]);
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const proposalById = new Map(
      proposals.map((proposal) => [proposal.id, proposal]),
    );
    const gapById = new Map(gaps.map((gap) => [gap.id, gap]));

    const items = rows.map((row): KnowledgeInboxItem => {
      const subject = live.get(keyOf(row.kind, row.subjectId));
      const base = {
        id: row.id,
        kind: row.kind as unknown as KnowledgeInboxKindEnum,
        subjectId: row.subjectId,
        raisedAt: row.raisedAt,
        assigneeId: row.assigneeId,
        doneAt: row.doneAt,
        doneById: row.doneById,
        resolution: row.resolution,
        pageTitle: null as string | null,
      };

      if (subject) {
        return { ...base, ...subject.view };
      }

      const entry = row.entryId ? entryById.get(row.entryId) : undefined;
      const proposal = proposalById.get(row.subjectId);
      const gap = gapById.get(row.subjectId);

      return {
        ...base,
        raisedBy:
          row.kind === KnowledgeInboxKind.GAP
            ? 'agents'
            : row.kind === KnowledgeInboxKind.ARCHIVE ||
                row.kind === KnowledgeInboxKind.REWRITE
              ? 'gardener'
              : 'triage',
        entry: entry ? (entry as unknown as KnowledgeReviewEntry) : null,
        pageId: entry?.pageId ?? proposal?.pageId ?? null,
        reasons: [],
        decision: null,
        proposal: proposal
          ? {
              id: proposal.id,
              summary: `Folds ${proposal.entryIds.length} ${
                proposal.entryIds.length === 1 ? 'fact' : 'facts'
              } into the page`,
            }
          : null,
        gap: gap ? { query: gap.query, count: gap.count } : null,
      };
    });

    const pageIds = [
      ...new Set(items.flatMap((item) => (item.pageId ? [item.pageId] : []))),
    ];
    const titles = new Map(
      pageIds.length
        ? (
            await this.prisma.page.findMany({
              where: { id: { in: pageIds }, workspaceId },
              select: { id: true, title: true },
            })
          ).map((page) => [page.id, page.title])
        : [],
    );

    return items.map((item) => ({
      ...item,
      pageTitle: item.pageId ? (titles.get(item.pageId) ?? null) : null,
    }));
  }
}
