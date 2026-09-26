import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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

import { VectorService } from 'modules/vector/vector.service';
import type { KnowledgeSearchHit } from 'modules/vector/vector.interface';

import KnowledgeIndexService from './knowledge-index.service';
import {
  ALLOWED_STATUS_TRANSITIONS,
  PROPOSED_ENTRY_BUDGET,
  PROPOSED_ENTRY_EXPIRY_DAYS,
  STANDING_ENTRY_DECAY_DAYS,
  WriterIdentity,
} from './pages.interface';

@Injectable()
export default class PageEntriesService {
  private readonly logger = new Logger(PageEntriesService.name);

  /**
   * The indexer and the vector service are optional for the same reason the
   * indexer is on PagesService: the index is a cache. A write that finds
   * Typesense down still gets the exact-duplicate check, which is postgres.
   */
  constructor(
    private prisma: PrismaService,
    private indexer?: KnowledgeIndexService,
    private vectorService?: VectorService,
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
      select: { id: true, title: true, entryPolicy: true, workspaceId: true },
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
    } else if (!entryData.distinct) {
      await this.assertNotAlreadyKnown(page, entryData, {
        // A person writing a standing fact in the webapp is the reviewer, with
        // the page open in front of them; asking them to confirm that a fact
        // merely resembling another is distinct would be asking the reviewer
        // to review themselves. An exact repeat is still refused.
        nearMatches: isAgent || !entryData.standing,
      });
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

    // The new entry enters the index in the same breath as it is written. A
    // human writing a fact by hand *is* the review step, so it lands STANDING
    // and is served immediately — without this it would sit unsearchable until
    // some later, unrelated write happened to touch it.
    await this.indexer?.entryChanged(entry.id);

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
      select: { status: true, sourceUserId: true },
    });

    if (!current) {
      throw new NotFoundException({ message: `Entry ${entryId} not found` });
    }

    if (await this.isAgent(userId)) {
      this.assertAgentMayEdit(current, userId, entryData);
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
    userId: string,
    input: BulkUpdatePageEntriesDto,
  ): Promise<{ updated: number; skipped: number }> {
    // Every bulk request is a triage decision — it only sets a status — and
    // triage is the review step an agent's writes wait for. An agent able to
    // make it would be its own reviewer.
    if (await this.isAgent(userId)) {
      throw new ForbiddenException({
        message:
          'Triage is for people: accepting, disputing or archiving entries in ' +
          'bulk decides what the workspace believes, and an agent cannot make ' +
          'that decision about knowledge. Nothing was changed. To withdraw ' +
          'one of your own untriaged entries, archive it on its own.',
      });
    }

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
        ALLOWED_STATUS_TRANSITIONS[
          entry.status as PageEntryStatusEnum
        ].includes(input.status),
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
   * A standing entry nothing has retrieved within a longer window archives on
   * that window, because unused knowledge is by definition not load-bearing.
   * The window is measured from the last time the entry was served, not from
   * whether it was ever served: an entry read once in its first week and never
   * again is as unused as one nobody read, and one read yesterday is not.
   * Nothing is deleted either way — archived entries stay readable and can be
   * revived.
   *
   * Called nightly by `PagesProcessor` on the `pages` queue, on the schedule in
   * `DECAY_CRON`. Setting `PAGE_DECAY_CRON=off` disables the pass, which leaves
   * both windows dormant and the inbox bounded only by the per-token budget on
   * curated pages — worth knowing before turning it off.
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
        createdAt: { lt: standingCutoff },
        OR: [
          { lastServedAt: { lt: standingCutoff } },
          // Never served. `retrievalCount` is checked as well because rows
          // counted before `lastServedAt` was recorded carry a count and no
          // date, and a count says somebody read them.
          { lastServedAt: null, retrievalCount: 0 },
        ],
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

  /**
   * What an agent may change on an entry: the wording, scope or withdrawal of
   * its own claim while it still waits in the inbox, and nothing else.
   *
   * Promoting, disputing and verifying are triage, which is the review an
   * agent's writes wait for; an agent able to make those calls would be its
   * own reviewer. Editing an entry somebody already accepted is the same thing
   * by another route — the text would change under a decision made about
   * different text — so a correction to standing knowledge is a new entry that
   * supersedes it, which lands in the inbox like any other claim.
   */
  private assertAgentMayEdit(
    current: { status: string; sourceUserId: string | null },
    userId: string,
    entryData: UpdatePageEntryDto,
  ): void {
    if (entryData.verified !== undefined) {
      throw new ForbiddenException({
        message:
          'Only a person can verify an entry: verification is a human saying ' +
          'the claim is true, and it outranks everything else the bank knows ' +
          'about it. Nothing was changed.',
      });
    }

    const statusChange =
      entryData.status !== undefined && entryData.status !== current.status
        ? entryData.status
        : undefined;

    if (statusChange && statusChange !== PageEntryStatusEnum.ARCHIVED) {
      throw new ForbiddenException({
        message:
          `An agent cannot move an entry to ${statusChange}: deciding whether ` +
          'a fact stands is triage, and triage is for people. Nothing was ' +
          'changed. You can archive one of your own untriaged entries to ' +
          'withdraw it.',
      });
    }

    if (current.sourceUserId !== userId) {
      throw new ForbiddenException({
        message:
          'This entry was written by someone else. An agent may only edit or ' +
          'withdraw its own entries. To correct it, write a new entry that ' +
          'supersedes it. Nothing was changed.',
      });
    }

    if (current.status !== PageEntryStatusEnum.PROPOSED) {
      throw new ForbiddenException({
        message:
          `This entry is already ${current.status}, so the workspace has ` +
          'decided about it. To correct it, write a new entry that supersedes ' +
          'it. Nothing was changed.',
      });
    }
  }

  /**
   * Refuses a write the page already holds, and hands back what it holds.
   *
   * Rediscovering the same fact is the flood this bank exists to prevent: ten
   * well-behaved agents each appending the same six facts. The check lives
   * here, under every client, because a check in one client is skipped by
   * every other — the REST API, the CLI and a harness calling the endpoint
   * directly all arrive here.
   *
   * Two tiers. An exact repeat, after normalising case and whitespace, is
   * found in postgres and refused for every writer. A near match is found by
   * the hybrid search `findSimilarEntries` runs, and is best effort: with the
   * index unreachable the write goes ahead on the exact check alone, because a
   * cache being down is not a reason to stop recording knowledge.
   */
  private async assertNotAlreadyKnown(
    page: { id: string; title: string; workspaceId: string },
    entryData: CreatePageEntryDto,
    options: { nearMatches: boolean },
  ): Promise<void> {
    const normalised = normaliseContent(entryData.content);

    const candidates = await this.prisma.pageEntry.findMany({
      where: {
        pageId: page.id,
        deleted: null,
        status: {
          in: [PageEntryStatusEnum.PROPOSED, PageEntryStatusEnum.STANDING],
        },
      },
      select: {
        id: true,
        content: true,
        scope: true,
        status: true,
        sourceUserId: true,
        verifiedAt: true,
        retrievalCount: true,
      },
    });

    const matches: KnowledgeSearchHit[] = candidates
      .filter((entry) => normaliseContent(entry.content) === normalised)
      .map((entry) => ({
        id: entry.id,
        kind: 'entry',
        pageId: page.id,
        pageTitle: page.title,
        entryId: entry.id,
        title: page.title,
        content: entry.content,
        scope: entry.scope,
        status: entry.status,
        sourceUserId: entry.sourceUserId,
        verified: entry.verifiedAt !== null,
        retrievalCount: entry.retrievalCount,
      }));

    if (options.nearMatches && this.vectorService) {
      try {
        const near = await this.vectorService.findSimilarEntries(
          page.workspaceId,
          page.id,
          entryData.content,
        );
        const known = new Set(matches.map((match) => match.entryId));
        matches.push(...near.filter((hit) => !known.has(hit.entryId)));
      } catch (error) {
        this.logger.warn(
          `Near-match check skipped for page ${page.id}: ` +
            `${(error as Error).message}`,
        );
      }
    }

    if (matches.length === 0) {
      return;
    }

    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      status: 'needs-decision',
      message:
        `"${page.title}" already holds ${matches.length} ` +
        `${matches.length === 1 ? 'entry' : 'entries'} like this one. ` +
        'Nothing was written. Pass `supersedesId` with the id of the entry ' +
        'this replaces, or `distinct: true` to say it is a separate fact.',
      nearMatches: matches,
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

/**
 * The form two entries are compared in. Case and runs of whitespace are how
 * the same sentence differs between two sessions that learned it; anything
 * more is a different sentence, and deciding whether it is a different fact
 * is the near-match check's job.
 */
export function normaliseContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

function firstLine(content: string): string {
  const line = content.trim().split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
