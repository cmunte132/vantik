import { Injectable } from '@nestjs/common';
import {
  AgentRunStatus,
  KnowledgeTriageDecisionType,
  PageEntryCitationCheck,
  PageEntryCitationKind,
  PageEntryStatus,
  PageProposalState,
} from '@prisma/client';
import {
  type KnowledgeFactCounts,
  type KnowledgeOverview,
  type KnowledgeOverviewPage,
  KnowledgeTrustEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { liveEntryIn } from 'common/page-entry-where';

import { entryTrust } from './knowledge-proof';
import KnowledgeReviewService from './knowledge-review.service';
import LooseFactsService from './loose-facts.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const USE_WINDOW_MS = 30 * DAY_MS;

/** A gap shows on the home only when agents asked it this many times. */
export const MIN_GAP_ASKS = 2;

/** The most gaps the home shows. */
const MAX_GAPS = 10;

/** The longest summary of a page body, in characters. */
export const MAX_SUMMARY = 180;

/** The issues of a linked project that the product vote reads. */
const MAX_PROJECT_ISSUES = 200;

const IN_USE = [PageEntryStatus.STANDING, PageEntryStatus.CONSOLIDATED];
const FAILED: string[] = [
  PageEntryCitationCheck.CHANGED,
  PageEntryCitationCheck.MISSING,
];
const LIVE_RUN = [
  AgentRunStatus.QUEUED,
  AgentRunStatus.CLAIMED,
  AgentRunStatus.RUNNING,
];

/**
 * The Pages home in one read: counts of the facts in use by their evidence,
 * each page with its product and the trust of its facts, the gaps agents
 * could not close, and the gaps an agent works on now.
 */
@Injectable()
export default class KnowledgeOverviewService {
  constructor(
    private prisma: PrismaService,
    private review: KnowledgeReviewService,
    private looseFacts: LooseFactsService,
  ) {}

  async overview(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<KnowledgeOverview> {
    const weekAgo = new Date(now.getTime() - WEEK_MS);

    const [pages, entries, queue, products] = await Promise.all([
      this.prisma.page.findMany({
        where: { workspaceId, deleted: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          title: true,
          parentId: true,
          kind: true,
          description: true,
          question: true,
          updatedAt: true,
        },
      }),
      this.prisma.pageEntry.findMany({
        where: {
          deleted: null,
          status: { in: IN_USE },
          ...liveEntryIn(workspaceId),
        },
        select: {
          id: true,
          pageId: true,
          status: true,
          verifiedAt: true,
          provisionalSince: true,
          moduleIds: true,
          citations: {
            select: { kind: true, checkResult: true, checkedAt: true },
          },
        },
      }),
      this.review.queue(workspaceId),
      this.prisma.product.findMany({
        where: { workspaceId, deleted: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
    ]);

    const pageIds = pages.map((page) => page.id);
    const [uses, proposals, productOf] = await Promise.all([
      this.usesByEntry(workspaceId, now),
      this.prisma.pageProposal.findMany({
        where: { state: PageProposalState.OPEN, pageId: { in: pageIds } },
        select: { pageId: true },
      }),
      this.productsOf(
        workspaceId,
        pages,
        entries,
        new Set(products.map((product) => product.id)),
      ),
    ]);

    const perPage = new Map<string, KnowledgeFactCounts>();
    const given = new Map<string, number>();
    const outOfDate = new Set<string>();
    const total = emptyCounts();

    for (const entry of entries) {
      const trust = entryTrust(entry, now);

      countTrust(total, trust);

      // A loose fact counts in the workspace, and on no page.
      if (!entry.pageId) {
        continue;
      }

      const counts = perPage.get(entry.pageId) ?? emptyCounts();

      perPage.set(entry.pageId, counts);
      countTrust(counts, trust);
      given.set(
        entry.pageId,
        (given.get(entry.pageId) ?? 0) + (uses.get(entry.id) ?? 0),
      );

      if (
        entry.status === PageEntryStatus.CONSOLIDATED &&
        entry.citations.some((citation) =>
          FAILED.includes(citation.checkResult ?? ''),
        )
      ) {
        outOfDate.add(entry.pageId);
      }
    }

    for (const item of queue.items) {
      total.needYou++;

      if (!item.entry.pageId) {
        continue;
      }

      const counts = perPage.get(item.entry.pageId) ?? emptyCounts();

      perPage.set(item.entry.pageId, counts);
      counts.needYou++;
    }

    const rewriting = new Set(proposals.map((proposal) => proposal.pageId));

    for (const pageId of rewriting) {
      const counts = perPage.get(pageId) ?? emptyCounts();

      perPage.set(pageId, counts);
      counts.needYou++;
      total.needYou++;
    }

    const [week, gardenerAt, gaps, research, loose] = await Promise.all([
      this.week(workspaceId, weekAgo),
      this.gardenerAt(workspaceId),
      this.prisma.pageKnowledgeGap.findMany({
        where: {
          workspaceId,
          answeredAt: null,
          count: { gte: MIN_GAP_ASKS },
        },
        orderBy: [{ count: 'desc' }, { updatedAt: 'desc' }],
        take: MAX_GAPS * 2,
        select: { id: true, query: true, count: true, updatedAt: true },
      }),
      this.research(workspaceId),
      this.looseFacts.loose(workspaceId),
    ]);
    // A gap that an agent researches now shows in the background list only.
    const researched = new Set(research.map((item) => item.gapId));

    return {
      autoTriage: queue.autoTriage,
      facts: total,
      week,
      gardenerAt: gardenerAt?.toISOString() ?? null,
      products,
      pages: pages.map((page): KnowledgeOverviewPage => ({
        id: page.id,
        title: page.title,
        parentId: page.parentId,
        kind: page.kind,
        summary: bodySummary(page.description) ?? (page.question || null),
        updatedAt: page.updatedAt.toISOString(),
        productId: productOf.get(page.id) ?? null,
        facts: perPage.get(page.id) ?? emptyCounts(),
        rewriteWaiting: rewriting.has(page.id),
        outOfDate: outOfDate.has(page.id),
        given30d: given.get(page.id) ?? 0,
      })),
      gaps: gaps
        .filter((gap) => !researched.has(gap.id))
        .slice(0, MAX_GAPS)
        .map((gap) => ({
          id: gap.id,
          query: gap.query,
          count: gap.count,
          lastAskedAt: gap.updatedAt.toISOString(),
        })),
      research,
      loose,
    };
  }

  /** How often each entry was given to an agent in the last 30 days. */
  private async usesByEntry(
    workspaceId: string,
    now: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.pageEntryUse.groupBy({
      by: ['entryId'],
      where: {
        workspaceId,
        createdAt: { gte: new Date(now.getTime() - USE_WINDOW_MS) },
      },
      _count: { _all: true },
    });

    return new Map(rows.map((row) => [row.entryId, row._count._all]));
  }

  /**
   * Each page's product. The modules of the page's links and of its facts
   * vote for the products that own them. A PRODUCT link wins outright.
   */
  private async productsOf(
    workspaceId: string,
    pages: Array<{ id: string; parentId: string | null }>,
    entries: Array<{ pageId: string | null; moduleIds: string[] }>,
    products: Set<string>,
  ): Promise<Map<string, string>> {
    const links = await this.prisma.pageLink.findMany({
      where: { deleted: null, pageId: { in: pages.map((page) => page.id) } },
      select: { pageId: true, entityType: true, entityId: true },
    });
    const idsOf = (type: string) =>
      links.filter((link) => link.entityType === type).map((l) => l.entityId);

    const [modules, issues, projectIssues] = await Promise.all([
      this.prisma.module.findMany({
        where: { workspaceId, deleted: null },
        select: { id: true, ownerProductId: true },
      }),
      this.prisma.issue.findMany({
        where: { id: { in: idsOf('ISSUE') }, deleted: null },
        select: { id: true, moduleIds: true },
      }),
      this.prisma.issue.findMany({
        where: {
          projectId: { in: idsOf('PROJECT') },
          deleted: null,
          team: { workspaceId },
        },
        orderBy: { updatedAt: 'desc' },
        take: MAX_PROJECT_ISSUES,
        select: { projectId: true, moduleIds: true },
      }),
    ]);

    const productOfModule = new Map(
      modules
        .filter((module) => module.ownerProductId)
        .map((module) => [module.id, module.ownerProductId as string]),
    );
    const issueModules = new Map(
      issues.map((issue) => [issue.id, issue.moduleIds]),
    );
    const projectModules = new Map<string, string[]>();

    for (const issue of projectIssues) {
      if (issue.projectId) {
        projectModules.set(issue.projectId, [
          ...(projectModules.get(issue.projectId) ?? []),
          ...issue.moduleIds,
        ]);
      }
    }

    const votes: PageVotes = new Map();
    const vote = (pageId: string, moduleIds: string[]) => {
      for (const moduleId of moduleIds) {
        const productId = productOfModule.get(moduleId);

        if (productId) {
          addVote(votes, pageId, productId, 1);
        }
      }
    };

    for (const link of links) {
      if (link.entityType === 'PRODUCT' && products.has(link.entityId)) {
        addVote(votes, link.pageId, link.entityId, Number.MAX_SAFE_INTEGER);
      } else if (link.entityType === 'MODULE') {
        vote(link.pageId, [link.entityId]);
      } else if (link.entityType === 'ISSUE') {
        vote(link.pageId, issueModules.get(link.entityId) ?? []);
      } else if (link.entityType === 'PROJECT') {
        vote(link.pageId, projectModules.get(link.entityId) ?? []);
      }
    }

    for (const entry of entries) {
      if (entry.pageId) {
        vote(entry.pageId, entry.moduleIds);
      }
    }

    return resolveProducts(pages, votes);
  }

  /** What agents wrote this week, and what triage settled of it. */
  private async week(
    workspaceId: string,
    since: Date,
  ): Promise<KnowledgeOverview['week']> {
    const [written, decisions, gapsClosed] = await Promise.all([
      this.prisma.pageEntry.findMany({
        where: {
          deleted: null,
          createdAt: { gte: since },
          ...liveEntryIn(workspaceId),
          sourceUserId: { not: null },
        },
        select: { id: true, sourceUserId: true },
      }),
      this.prisma.knowledgeTriageDecision.findMany({
        where: {
          workspaceId,
          createdAt: { gte: since },
          decision: {
            in: [
              KnowledgeTriageDecisionType.AUTO_ACCEPT,
              KnowledgeTriageDecisionType.CORROBORATE,
            ],
          },
        },
        distinct: ['entryId'],
        select: {
          entryId: true,
          entry: { select: { citations: { select: { kind: true } } } },
        },
      }),
      this.prisma.pageKnowledgeGap.count({
        where: { workspaceId, answeredAt: { gte: since } },
      }),
    ]);

    const agents = new Set(
      (
        await this.prisma.user.findMany({
          where: {
            id: {
              in: [
                ...new Set(written.map((entry) => entry.sourceUserId)),
              ].filter((id): id is string => Boolean(id)),
            },
            type: 'Agent',
          },
          select: { id: true },
        })
      ).map((user) => user.id),
    );
    const byAgents = new Set(
      written
        .filter((entry) => agents.has(entry.sourceUserId ?? ''))
        .map((entry) => entry.id),
    );
    const settled = decisions.filter((decision) =>
      byAgents.has(decision.entryId),
    );

    return {
      written: byAgents.size,
      settled: settled.length,
      settledObserved: settled.filter((decision) =>
        decision.entry.citations.some(
          (citation) => citation.kind === PageEntryCitationKind.URL,
        ),
      ).length,
      gapsClosed,
    };
  }

  /** The newest thing the gardener did: a triage decision, a look, a check. */
  private async gardenerAt(workspaceId: string): Promise<Date | null> {
    const [decision, maintenance, verification] = await Promise.all([
      this.prisma.knowledgeTriageDecision.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.pageEntryMaintenance.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.knowledgeVerification.findFirst({
        where: { workspaceId },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
    ]);
    const times = [
      decision?.createdAt,
      maintenance?.createdAt,
      verification?.updatedAt,
    ].filter((time): time is Date => Boolean(time));

    return times.length
      ? new Date(Math.max(...times.map((time) => time.getTime())))
      : null;
  }

  /** Gaps whose issue an agent run works on now. */
  private async research(
    workspaceId: string,
  ): Promise<KnowledgeOverview['research']> {
    const gaps = await this.prisma.pageKnowledgeGap.findMany({
      where: { workspaceId, answeredAt: null, issueId: { not: null } },
      select: { id: true, query: true, issueId: true },
    });

    if (!gaps.length) {
      return [];
    }

    const runs = await this.prisma.agentRun.findMany({
      where: {
        issueId: { in: gaps.map((gap) => gap.issueId as string) },
        status: { in: LIVE_RUN },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, issueId: true, createdAt: true, startedAt: true },
    });

    return Promise.all(
      gaps.flatMap((gap) => {
        const run = runs.find((candidate) => candidate.issueId === gap.issueId);

        return run
          ? [
              this.prisma.agentRunEvent
                .findFirst({
                  where: { runId: run.id },
                  orderBy: { at: 'desc' },
                  select: { message: true },
                })
                .then((event) => ({
                  gapId: gap.id,
                  query: gap.query,
                  runId: run.id,
                  activity: event?.message ?? null,
                  startedAt: (run.startedAt ?? run.createdAt).toISOString(),
                })),
            ]
          : [];
      }),
    );
  }
}

type PageVotes = Map<string, Map<string, number>>;

function addVote(
  votes: PageVotes,
  pageId: string,
  productId: string,
  weight: number,
): void {
  const tally = votes.get(pageId) ?? new Map<string, number>();

  votes.set(pageId, tally);
  tally.set(
    productId,
    Math.min(Number.MAX_SAFE_INTEGER, (tally.get(productId) ?? 0) + weight),
  );
}

/**
 * Each page's product from its votes: the product with the most, and on a
 * tie the smaller id, so the answer does not change between reads. A page
 * with no votes takes its nearest ancestor's product.
 */
export function resolveProducts(
  pages: Array<{ id: string; parentId: string | null }>,
  votes: PageVotes,
): Map<string, string> {
  const own = new Map<string, string>();

  for (const [pageId, tally] of votes) {
    const [best] = [...tally.entries()].sort(
      ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b),
    );

    if (best) {
      own.set(pageId, best[0]);
    }
  }

  const parentOf = new Map(pages.map((page) => [page.id, page.parentId]));
  const resolved = new Map<string, string>();

  for (const page of pages) {
    const seen = new Set<string>();
    let at: string | null = page.id;

    while (at && !seen.has(at)) {
      seen.add(at);

      const product = own.get(at);

      if (product) {
        resolved.set(page.id, product);
        break;
      }

      at = parentOf.get(at) ?? null;
    }
  }

  return resolved;
}

function emptyCounts(): KnowledgeFactCounts {
  return {
    inUse: 0,
    code: 0,
    people: 0,
    observed: 0,
    provisional: 0,
    unconfirmed: 0,
    needYou: 0,
  };
}

function countTrust(counts: KnowledgeFactCounts, trust: KnowledgeTrustEnum) {
  counts.inUse++;

  if (trust === KnowledgeTrustEnum.HUMAN_VERIFIED) {
    counts.people++;
  } else if (trust === KnowledgeTrustEnum.GROUNDED) {
    counts.code++;
  } else if (trust === KnowledgeTrustEnum.OBSERVED) {
    counts.observed++;
  } else if (trust === KnowledgeTrustEnum.PROVISIONAL) {
    counts.provisional++;
  } else {
    counts.unconfirmed++;
  }
}

/**
 * The first paragraph of a page body, as plain text and cut to
 * `MAX_SUMMARY`. The body is Tiptap JSON. A body that is not JSON is read as
 * text. Headings are skipped: the title already says what a heading says.
 */
export function bodySummary(description: string | null): string | null {
  if (!description?.trim()) {
    return null;
  }

  let text: string | null = null;

  try {
    text = firstParagraph(JSON.parse(description));
  } catch {
    text = description;
  }

  const flat = (text ?? '').replace(/\s+/g, ' ').trim();

  if (!flat) {
    return null;
  }

  return flat.length > MAX_SUMMARY
    ? `${flat.slice(0, MAX_SUMMARY - 1).trimEnd()}…`
    : flat;
}

interface TiptapNode {
  type?: string;
  text?: string;
  content?: TiptapNode[];
}

function textOf(node: TiptapNode): string {
  if (typeof node.text === 'string') {
    return node.text;
  }

  return (node.content ?? []).map(textOf).join(node.type === 'doc' ? ' ' : '');
}

function firstParagraph(node: TiptapNode): string | null {
  if (node.type === 'paragraph') {
    const text = textOf(node).trim();

    return text || null;
  }

  if (node.type === 'heading' || node.type === 'codeBlock') {
    return null;
  }

  for (const child of node.content ?? []) {
    const found = firstParagraph(child);

    if (found) {
      return found;
    }
  }

  return null;
}
