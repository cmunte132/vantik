import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BulkUpdatePageEntriesDto,
  CreatePageEntryDto,
  PageEntry,
  PageEntryPolicyEnum,
  PageEntryStatusEnum,
  UpdatePageEntryDto,
  UserTypeEnum,
} from '@vantikhq/types';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import KnowledgeIndexService from './knowledge-index.service';
import {
  ALLOWED_STATUS_TRANSITIONS,
  PROPOSED_ENTRY_BUDGET,
  PROPOSED_ENTRY_EXPIRY_DAYS,
  STANDING_ENTRY_DECAY_DAYS,
  WriterIdentity,
} from './pages.interface';

/** Facet counts, which is what makes reviewing fifty entries tractable. */
export interface EntryFacets {
  total: number;
  status: Record<string, number>;
  sourceUserId: Record<string, number>;
  scope: Record<string, number>;
}

@Injectable()
export default class PageEntriesService {
  /** Optional for the same reason it is on PagesService: indexing is a cache. */
  constructor(
    private prisma: PrismaService,
    private indexer?: KnowledgeIndexService,
  ) {}

  // ----------------------------------------------------------------- reading

  async getEntries(
    workspaceId: string,
    filters: { pageId?: string; status?: PageEntryStatusEnum[] } = {},
  ): Promise<PageEntry[]> {
    return this.prisma.pageEntry.findMany({
      where: {
        deleted: null,
        page: { workspaceId, deleted: null },
        ...(filters.pageId ? { pageId: filters.pageId } : {}),
        ...(filters.status?.length ? { status: { in: filters.status } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    }) as unknown as Promise<PageEntry[]>;
  }

  /**
   * Counts by source, scope and status.
   *
   * A rail that lists entries one per row is usable at five and abandoned at
   * fifty, and fifty is the realistic steady state for an active page. Grouped
   * counts turn "38 proposed" into four decisions — accept everything
   * claude-opus-5 asserted about `apps/server/prisma`, archive the rest —
   * instead of thirty-eight.
   */
  async getFacets(workspaceId: string, pageId?: string): Promise<EntryFacets> {
    const where: Prisma.PageEntryWhereInput = {
      deleted: null,
      page: { workspaceId, deleted: null },
      ...(pageId ? { pageId } : {}),
    };

    const [byStatus, bySource, byScope, total] = await Promise.all([
      this.prisma.pageEntry.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.pageEntry.groupBy({
        by: ['sourceUserId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.pageEntry.groupBy({
        by: ['scope'],
        where,
        _count: { _all: true },
      }),
      this.prisma.pageEntry.count({ where }),
    ]);

    return {
      total,
      status: tally(byStatus, 'status'),
      sourceUserId: tally(bySource, 'sourceUserId'),
      scope: tally(byScope, 'scope'),
    };
  }

  // ----------------------------------------------------------------- writing

  /**
   * Appends one asserted fact to a page.
   *
   * Three mechanical gates stand in front of this, all server-side because a
   * client that ignores tool descriptions must not be able to walk past them:
   * the page's entry policy, the per-token budget on untriaged entries, and the
   * supersede pointer that stops a correction sitting beside the thing it
   * corrects.
   */
  async createEntry(
    pageId: string,
    writer: WriterIdentity,
    entryData: CreatePageEntryDto,
  ): Promise<PageEntry> {
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: { id: true, title: true, entryPolicy: true },
    });

    if (!page) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    const isAgent = await this.isAgent(writer.userId);

    if (page.entryPolicy === PageEntryPolicyEnum.LOCKED && isAgent) {
      throw new ForbiddenException({
        message:
          `"${page.title}" is locked: it is maintained by hand. Reads are ` +
          'unaffected — you can still recall and load context from it — but ' +
          'appending is not open to agents. Append to a related page instead, ' +
          'or ask a human to unlock this one.',
      });
    }

    if (page.entryPolicy === PageEntryPolicyEnum.CURATED) {
      await this.assertBudgetAvailable(page.id, page.title, writer);
    }

    if (entryData.supersedesId) {
      await this.assertSupersedable(entryData.supersedesId, pageId);
    }

    // An agent's writes always land in the inbox. A human reviewer working in
    // the webapp is the review step, so asking for STANDING directly is not a
    // way around triage — it *is* triage.
    const status =
      entryData.standing && !isAgent
        ? PageEntryStatusEnum.STANDING
        : PageEntryStatusEnum.PROPOSED;

    const [entry] = await this.prisma.$transaction([
      this.prisma.pageEntry.create({
        data: {
          content: entryData.content,
          scope: entryData.scope ?? null,
          status,
          sourceUserId: writer.userId,
          sourceSession: entryData.sourceSession ?? null,
          sourceTokenId: writer.tokenId,
          supersedesId: entryData.supersedesId ?? null,
          pageId,
        },
      }),
      // The replaced row keeps its content — the audit trail is the point — but
      // stops being served the moment its replacement exists, so a reader is
      // never handed both truths and left to pick.
      ...(entryData.supersedesId
        ? [
            this.prisma.pageEntry.update({
              where: { id: entryData.supersedesId },
              data: { status: PageEntryStatusEnum.SUPERSEDED },
            }),
          ]
        : []),
    ]);

    // A superseded entry has to leave the index in the same breath, or the
    // reader gets both the correction and the thing it corrected and has no
    // way to tell which is current.
    if (entryData.supersedesId) {
      await this.indexer?.entryChanged(entryData.supersedesId);
    }

    return entry as unknown as PageEntry;
  }

  async updateEntry(
    entryId: string,
    userId: string,
    entryData: UpdatePageEntryDto,
  ): Promise<PageEntry> {
    const current = await this.prisma.pageEntry.findFirst({
      where: { id: entryId, deleted: null },
      select: { status: true },
    });

    if (!current) {
      throw new NotFoundException({ message: `Entry ${entryId} not found` });
    }

    if (entryData.status !== undefined) {
      this.assertTransitionAllowed(
        current.status as PageEntryStatusEnum,
        entryData.status,
      );
    }

    // Named field by field for the same reason page updates are: the global
    // ValidationPipe does not whitelist, so a stray `pageId` would move an
    // asserted fact onto a page in another workspace and `retrievalCount` would
    // let a caller fake demonstrated usefulness.
    const entry = await this.prisma.pageEntry.update({
      where: { id: entryId },
      data: {
        ...(entryData.content !== undefined && { content: entryData.content }),
        ...(entryData.scope !== undefined && { scope: entryData.scope }),
        ...(entryData.status !== undefined && { status: entryData.status }),
        ...(entryData.verified !== undefined && {
          verifiedByUserId: entryData.verified ? userId : null,
          verifiedAt: entryData.verified ? new Date() : null,
        }),
      },
    });
    await this.indexer?.entryChanged(entryId);

    return entry as unknown as PageEntry;
  }

  /**
   * Applies one decision to a set of entries — the write half of facet-first
   * triage. Entries whose current status forbids the transition are skipped
   * rather than failing the batch, so one terminal row in a selection of forty
   * does not send the reviewer back to picking rows off one at a time.
   */
  async bulkUpdate(
    workspaceId: string,
    input: BulkUpdatePageEntriesDto,
  ): Promise<{ updated: number; skipped: number }> {
    const entries = await this.prisma.pageEntry.findMany({
      where: {
        id: { in: input.entryIds },
        deleted: null,
        page: { workspaceId, deleted: null },
      },
      select: { id: true, status: true },
    });

    const eligible = entries
      .filter((entry) =>
        ALLOWED_STATUS_TRANSITIONS[entry.status as PageEntryStatusEnum].includes(
          input.status,
        ),
      )
      .map((entry) => entry.id);

    if (eligible.length > 0) {
      await this.prisma.pageEntry.updateMany({
        where: { id: { in: eligible } },
        data: { status: input.status },
      });
      await this.indexer?.entriesChanged(eligible);
    }

    return {
      updated: eligible.length,
      skipped: input.entryIds.length - eligible.length,
    };
  }

  async deleteEntry(entryId: string): Promise<PageEntry> {
    const entry = await this.prisma.pageEntry.update({
      where: { id: entryId },
      data: { deleted: new Date() },
    });
    await this.indexer?.entryChanged(entryId);

    return entry as unknown as PageEntry;
  }

  // ------------------------------------------------------- serving and decay

  /**
   * Records that entries were actually served.
   *
   * `increment` compiles to `SET "retrievalCount" = "retrievalCount" + 1`, so
   * two searches landing on the same entry at the same moment both count —
   * a read-then-write would lose one, and this number decides what survives
   * the decay pass.
   */
  async recordServed(entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }

    await this.prisma.pageEntry.updateMany({
      where: { id: { in: entryIds } },
      data: { retrievalCount: { increment: 1 }, lastServedAt: new Date() },
    });
  }

  /**
   * Ages out knowledge nobody is using, in the two ways it goes stale.
   *
   * An untriaged entry that has sat in the inbox past the window archives
   * itself: an unbounded inbox is what actually overwhelms a person, and a
   * reviewer who opens a rail of four hundred rows closes it again.
   *
   * A standing entry nothing has ever retrieved archives on a longer window,
   * because unused knowledge is by definition not load-bearing. Nothing is
   * deleted either way — archived entries stay readable and can be revived.
   */
  async runDecay(workspaceId?: string): Promise<{
    expiredProposed: number;
    archivedStanding: number;
  }> {
    const scope: Prisma.PageEntryWhereInput = workspaceId
      ? { page: { workspaceId, deleted: null } }
      : { page: { deleted: null } };

    const proposedCutoff = daysAgo(PROPOSED_ENTRY_EXPIRY_DAYS);
    const standingCutoff = daysAgo(STANDING_ENTRY_DECAY_DAYS);

    const expiredProposed = await this.prisma.pageEntry.updateMany({
      where: {
        ...scope,
        deleted: null,
        status: PageEntryStatusEnum.PROPOSED,
        createdAt: { lt: proposedCutoff },
      },
      data: { status: PageEntryStatusEnum.ARCHIVED },
    });

    const archivedStanding = await this.prisma.pageEntry.updateMany({
      where: {
        ...scope,
        deleted: null,
        status: PageEntryStatusEnum.STANDING,
        retrievalCount: 0,
        createdAt: { lt: standingCutoff },
        // A human vouched for it. Demonstrated usefulness is a proxy for
        // "worth keeping"; an explicit human confirmation is the real thing,
        // and it outranks the proxy.
        verifiedAt: null,
      },
      data: { status: PageEntryStatusEnum.ARCHIVED },
    });

    return {
      expiredProposed: expiredProposed.count,
      archivedStanding: archivedStanding.count,
    };
  }

  // --------------------------------------------------------------- internals

  /**
   * Refuses an append once a token is holding too many untriaged entries on one
   * curated page, and says what to do about it.
   *
   * The refusal names the entries in the way of the write, because a dead end
   * teaches an agent nothing and it will simply try the same append again. This
   * is the same posture `assertSubstantialIssue` takes for thin issues: the
   * error is the instruction.
   */
  private async assertBudgetAvailable(
    pageId: string,
    pageTitle: string,
    writer: WriterIdentity,
  ): Promise<void> {
    // A browser session carries no token, so the account stands in for one.
    // Falling back to no key at all would count every caller's writes together
    // and let one agent exhaust everybody's allowance.
    const budgetKey: Prisma.PageEntryWhereInput = writer.tokenId
      ? { sourceTokenId: writer.tokenId }
      : { sourceTokenId: null, sourceUserId: writer.userId };

    const outstanding = await this.prisma.pageEntry.findMany({
      where: {
        pageId,
        deleted: null,
        status: PageEntryStatusEnum.PROPOSED,
        ...budgetKey,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, content: true },
    });

    if (outstanding.length < PROPOSED_ENTRY_BUDGET) {
      return;
    }

    const listed = outstanding
      .slice(0, PROPOSED_ENTRY_BUDGET)
      .map((entry) => `- ${entry.id}: ${firstLine(entry.content)}`)
      .join('\n');

    throw new ForbiddenException({
      message:
        `You already have ${outstanding.length} untriaged entries on ` +
        `"${pageTitle}", which is the limit for one token on a curated page. ` +
        'Nothing was created. Consolidate what is there or supersede the entry ' +
        'this one replaces, then append again. Outstanding:\n' +
        `${listed}`,
    });
  }

  private async assertSupersedable(
    supersedesId: string,
    pageId: string,
  ): Promise<void> {
    const target = await this.prisma.pageEntry.findFirst({
      where: { id: supersedesId, deleted: null, pageId },
      select: { status: true, supersededBy: { select: { id: true } } },
    });

    if (!target) {
      throw new NotFoundException({
        message: `Entry ${supersedesId} is not on this page`,
      });
    }

    if (target.supersededBy) {
      throw new BadRequestException({
        message:
          `Entry ${supersedesId} has already been superseded by ` +
          `${target.supersededBy.id}. Supersede that one instead — a fact with ` +
          'two replacements is a contradiction, not a correction.',
      });
    }
  }

  private assertTransitionAllowed(
    from: PageEntryStatusEnum,
    to: PageEntryStatusEnum,
  ): void {
    if (from === to) {
      return;
    }

    if (!ALLOWED_STATUS_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException({
        message:
          `An entry cannot go from ${from} to ${to}. ` +
          (ALLOWED_STATUS_TRANSITIONS[from].length === 0
            ? `${from} is terminal: the workspace has already decided about ` +
              'this fact, and reviving it would put it back into circulation.'
            : `From ${from} the options are ` +
              `${ALLOWED_STATUS_TRANSITIONS[from].join(', ')}.`),
      });
    }
  }

  private async isAgent(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { type: true },
    });

    return user?.type === UserTypeEnum.Agent;
  }
}

function tally<T extends string>(
  groups: Array<Record<string, unknown> & { _count: { _all: number } }>,
  key: T,
): Record<string, number> {
  return groups.reduce<Record<string, number>>((counts, group) => {
    counts[String(group[key] ?? '')] = group._count._all;
    return counts;
  }, {});
}

function firstLine(content: string): string {
  const line = content.trim().split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
