import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import {
  KnowledgeSearchHit,
  KnowledgeSearchResult,
} from 'modules/vector/vector.interface';
import { VectorService } from 'modules/vector/vector.service';

import PageEntriesService from './page-entries.service';

/**
 * A context pack: the knowledge that matters for a piece of work, under a
 * budget.
 */
export interface ContextPack {
  items: KnowledgeSearchHit[];
  /** Tokens the pack is estimated to occupy, against the budget asked for. */
  estimatedTokens: number;
  tokenBudget: number;
  /** Items that matched but did not fit. Honest about what was left out. */
  omitted: number;
}

export interface KnowledgeGap {
  query: string;
  count: number;
  lastAskedAt: Date;
}

/**
 * Rough tokens per character.
 *
 * Deliberately crude: the budget exists to bound the pack, not to be exact, and
 * a tokenizer here would tie the server to one model family's vocabulary when
 * the whole point of the bank is that several different harnesses read it.
 */
const CHARS_PER_TOKEN = 4;

/** Ceiling on a caller-supplied budget, so "budget" cannot mean "everything". */
const MAX_TOKEN_BUDGET = 20_000;
const DEFAULT_TOKEN_BUDGET = 2_000;

@Injectable()
export default class KnowledgeService {
  constructor(
    private prisma: PrismaService,
    private vectorService: VectorService,
    private pageEntriesService: PageEntriesService,
  ) {}

  /**
   * "What do we know about X."
   *
   * Serving an entry counts as demand for it, which is what later decides
   * whether it survives the decay pass — so the counters are written here
   * rather than left to the caller to remember.
   */
  async search(
    workspaceId: string,
    query: string,
    options: { limit?: number; scope?: string } = {},
  ): Promise<KnowledgeSearchResult> {
    const result = await this.vectorService.searchKnowledge(
      workspaceId,
      query,
      options,
    );

    await this.recordDemand(workspaceId, query, result.hits);

    return result;
  }

  /**
   * "Load what matters before I begin."
   *
   * The other half of the loop, and the half an agent cannot express as a
   * query, because it does not yet know what it does not know. The budget is
   * the whole point: without it this is an unbounded context dump that gets
   * worse as the bank grows, which is exactly how file-based memory fails
   * today.
   */
  async contextPack(
    workspaceId: string,
    input: { scope?: string; query?: string; tokenBudget?: number },
  ): Promise<ContextPack> {
    const tokenBudget = Math.min(
      Math.max(input.tokenBudget ?? DEFAULT_TOKEN_BUDGET, 1),
      MAX_TOKEN_BUDGET,
    );

    // With no query the scope itself is the question — "what do we know about
    // apps/server/prisma" — which is what an agent starting work can actually
    // supply.
    const query = input.query?.trim() || input.scope?.trim() || '*';

    const { hits } = await this.vectorService.searchKnowledge(
      workspaceId,
      query,
      {
        // Ask for more than will fit: grouping has already capped how much any
        // one page contributes, so the surplus is breadth across pages rather
        // than more of the same page.
        limit: 50,
        scope: input.scope,
      },
    );

    const items: KnowledgeSearchHit[] = [];
    let estimatedTokens = 0;

    for (const hit of hits) {
      const cost = estimateTokens(hit);

      if (estimatedTokens + cost > tokenBudget) {
        continue;
      }

      items.push(hit);
      estimatedTokens += cost;
    }

    // Counted against what the search *found*, not against what fit. A pack
    // that matched fifty things and could afford none of them answered the
    // question; recording it as a gap would put questions the bank handles well
    // at the top of the list of things nobody has written down.
    await this.recordDemand(workspaceId, query, items, hits.length);

    return {
      items,
      estimatedTokens,
      tokenBudget,
      omitted: hits.length - items.length,
    };
  }

  /** Near matches for a fact about to be written. Hints, never a veto. */
  async similarEntries(
    workspaceId: string,
    pageId: string,
    content: string,
  ): Promise<KnowledgeSearchHit[]> {
    return this.vectorService.findSimilarEntries(workspaceId, pageId, content);
  }

  /**
   * The questions the bank could not answer, most-asked first.
   *
   * The most valuable signal the system produces: it says which page to write
   * next, and it turns the bank from a record of what agents dumped into a
   * record of what agents needed.
   */
  async knowledgeGaps(
    workspaceId: string,
    limit = 50,
  ): Promise<KnowledgeGap[]> {
    const gaps = await this.prisma.pageKnowledgeGap.findMany({
      where: { workspaceId },
      orderBy: [{ count: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });

    return gaps.map((gap) => ({
      query: gap.query,
      count: gap.count,
      lastAskedAt: gap.updatedAt,
    }));
  }

  // --------------------------------------------------------------- internals

  /**
   * Records what a search actually produced: usage counts when it found
   * something, a knowledge gap when it did not.
   *
   * Both are best-effort. A failure to record demand must not fail the read the
   * caller asked for — the counters steer ranking and decay, and being slightly
   * behind is survivable in a way that a failed recall is not.
   */
  private async recordDemand(
    workspaceId: string,
    query: string,
    served: KnowledgeSearchHit[],
    /** What the search matched, which is not always what was served. */
    found = served.length,
  ): Promise<void> {
    try {
      const entryIds = served
        .map((hit) => hit.entryId)
        .filter((id): id is string => Boolean(id));

      if (entryIds.length > 0) {
        await this.pageEntriesService.recordServed(entryIds);
      }

      if (found === 0) {
        await this.recordKnowledgeGap(workspaceId, query);
      }
    } catch {
      // Deliberately silent: see the method comment.
    }
  }

  private async recordKnowledgeGap(
    workspaceId: string,
    query: string,
  ): Promise<void> {
    const normalised = query.trim().toLowerCase().replace(/\s+/g, ' ');

    // A wildcard is not a question anybody asked, and neither is an empty one.
    if (!normalised || normalised === '*') {
      return;
    }

    // Upsert on the unique pair, so asking twice increments a counter instead
    // of adding a row — the list has to read as demand, not as a query log.
    await this.prisma.pageKnowledgeGap.upsert({
      where: { workspaceId_query: { workspaceId, query: normalised } },
      create: { workspaceId, query: normalised },
      update: { count: { increment: 1 } },
    });
  }
}

function estimateTokens(hit: KnowledgeSearchHit): number {
  // Provenance travels with the item, so it costs budget too — an agent
  // weighing a claim needs to see that a human confirmed it, and pretending
  // that metadata is free is how a budget silently overruns.
  const text = `${hit.title}\n${hit.content}\n${hit.scope ?? ''}`;

  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
