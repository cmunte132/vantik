import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type KnowledgePackCandidate,
  KnowledgePackDropEnum,
  type KnowledgePackNearness,
  KnowledgeProof,
  KnowledgeTrustEnum,
  PageEntryKindEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { liveEntryIn } from 'common/page-entry-where';

import {
  KnowledgeSearchHit,
  KnowledgeSearchResult,
  SERVED_STATUSES,
} from 'modules/vector/vector.interface';
import { VectorService } from 'modules/vector/vector.service';

import {
  describeProof,
  entryProof,
  PROOF_CITATION_SELECT,
} from './knowledge-proof';
import {
  knowledgeSettings,
  MAX_KNOWLEDGE_TOKEN_BUDGET,
} from './knowledge-settings';
import PageEntriesService from './page-entries.service';
import { type ServedTo } from './pages.interface';

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

/** Where a piece of work is, in the product graph. */
export interface KnowledgeSeeds {
  moduleIds?: string[];
  issueId?: string;
}

/**
 * Who is reading, as far as the request says: recorded with each entry served,
 * so a use can be traced to the session, token or run it went to.
 */
export type KnowledgeReader = Omit<ServedTo, 'workspaceId' | 'via'>;

/**
 * One entry packed into a run: the claim, what it rests on, and when it was
 * written, so the agent can weigh a person's confirmation above a claim
 * nothing backs, and an old claim against a new one.
 */
export interface PackedEntry extends KnowledgeProof {
  entryId: string;
  /** FACT, DECISION, CONVENTION or GOTCHA. */
  kind: string;
  scope: string | null;
  body: string;
  writtenAt: string;
}

/** How a pack was chosen, before it is stored with what it was for. */
export interface PackTraceDraft {
  query: string;
  seedModuleIds: string[];
  neighbourModuleIds: string[];
  topK: number | null;
  tokenBudget: number;
  tokensGiven: number;
  searchFailed: boolean;
  candidates: KnowledgePackCandidate[];
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
const MAX_TOKEN_BUDGET = MAX_KNOWLEDGE_TOKEN_BUDGET;
const DEFAULT_TOKEN_BUDGET = 2_000;

/** How much knowledge a run may be handed. */
export interface RunKnowledgeLimits {
  topK: number;
  tokenBudget: number;
}

/**
 * The most conventions read for one run before the budget is applied. Bounds
 * the read; the budget bounds the pack.
 */
const MAX_PACKED_CONVENTIONS = 25;

/** Candidates asked of the search, so trust can filter and still leave K. */
const PACK_SEARCH_LIMIT = 20;

/** The trust a relevant entry needs to be packed without a person asking. */
const PACKABLE_TRUST: Array<KnowledgeTrustEnum | null> = [
  KnowledgeTrustEnum.GROUNDED,
  KnowledgeTrustEnum.OBSERVED,
  KnowledgeTrustEnum.HUMAN_VERIFIED,
];

/** The columns a packed entry is built from. */
const PACKED_ENTRY_SELECT = {
  id: true,
  content: true,
  scope: true,
  kind: true,
  status: true,
  verifiedAt: true,
  createdAt: true,
  moduleIds: true,
  citations: { select: PROOF_CITATION_SELECT },
} as const;

@Injectable()
export default class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

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
    options: {
      limit?: number;
      scope?: string;
      kinds?: string[];
      reader?: KnowledgeReader;
    } & KnowledgeSeeds = {},
  ): Promise<KnowledgeSearchResult> {
    const result = await this.vectorService.searchKnowledge(
      workspaceId,
      query,
      {
        limit: options.limit,
        scope: options.scope,
        kinds: options.kinds,
        boost: await this.seedsFor(workspaceId, options),
      },
    );

    await this.recordDemand(workspaceId, query, result.hits, {
      ...options.reader,
      workspaceId,
      via: 'RECALL',
    });

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
    input: {
      scope?: string;
      query?: string;
      tokenBudget?: number;
      reader?: KnowledgeReader;
    } & KnowledgeSeeds,
  ): Promise<ContextPack> {
    const tokenBudget = Math.min(
      Math.max(input.tokenBudget ?? DEFAULT_TOKEN_BUDGET, 1),
      MAX_TOKEN_BUDGET,
    );

    // With no query the scope itself is the question — "what do we know about
    // apps/server/prisma" — which is what an agent starting work can actually
    // supply.
    const query = input.query?.trim() || input.scope?.trim() || '*';
    const seeds = await this.seedsFor(workspaceId, input);

    const { hits } = await this.vectorService.searchKnowledge(
      workspaceId,
      query,
      {
        // Ask for more than will fit: grouping has already capped how much any
        // one page contributes, so the surplus is breadth across pages rather
        // than more of the same page.
        limit: 50,
        scope: input.scope,
        boost: seeds,
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

    // Never a knowledge gap. The query here is the task an agent is about to
    // do, or the area it works in, not a question it asked: a pack that finds
    // nothing says the area is new, and recording "add a retry to the webhook
    // worker" as a gap filled the list with work descriptions nobody could
    // answer. A question the bank cannot answer arrives through recall.
    await this.recordDemand(
      workspaceId,
      query,
      items,
      { ...input.reader, workspaceId, via: 'LOAD_CONTEXT' },
      { gap: false },
    );

    const given = new Set(items);
    let order = 0;

    await this.recordTrace(
      workspaceId,
      {
        query,
        seedModuleIds: seeds?.modules ?? [],
        neighbourModuleIds: seeds?.neighbours ?? [],
        topK: null,
        tokenBudget,
        tokensGiven: estimatedTokens,
        searchFailed: false,
        candidates: hits
          .map((hit, index) => ({ hit, index }))
          .filter(({ hit }) => Boolean(hit.entryId))
          .map(({ hit, index }): KnowledgePackCandidate => {
            const isGiven = given.has(hit);

            return {
              entryId: hit.entryId as string,
              source: 'SEARCH' as const,
              searchRank: index + 1,
              nearness: 'NONE' as const,
              trust: null,
              tokens: estimateTokens(hit),
              given: isGiven,
              order: isGiven ? ++order : null,
              dropped: isGiven ? null : KnowledgePackDropEnum.BUDGET,
            };
          }),
      },
      {
        via: 'LOAD_CONTEXT',
        userId: input.reader?.userId,
        sessionId: input.reader?.sessionId,
        issueId: input.issueId,
      },
    );

    return {
      items,
      estimatedTokens,
      tokenBudget,
      omitted: hits.length - items.length,
    };
  }

  /**
   * What a run on this issue is handed: the conventions of the issue's
   * modules, then the few entries most relevant to its title that are
   * grounded or verified by a person, within a token budget.
   *
   * Conventions come first and are not held to a trust tier: a person
   * accepted each one as how work is done in that module, and the agent is
   * told each item's tier either way. The relevant entries are, because
   * nobody chose them for this issue; a search did. Everything is read from
   * postgres, trust included, so an entry retracted or no longer grounded
   * since it was indexed is not packed. An index that cannot be reached
   * leaves the conventions, which do not need it.
   *
   * The limits are the workspace's settings unless given.
   */
  async knowledgeForRun(
    workspaceId: string,
    input: { issueId: string; query: string },
    given?: RunKnowledgeLimits,
  ): Promise<PackedEntry[]> {
    return (await this.tracedKnowledgeForRun(workspaceId, input, given))
      .packed;
  }

  /**
   * `knowledgeForRun`, with the trace of how the pack was chosen: every
   * entry considered, in the order it was considered, and why each one not
   * given was dropped.
   */
  async tracedKnowledgeForRun(
    workspaceId: string,
    input: { issueId: string; query: string },
    given?: RunKnowledgeLimits,
  ): Promise<{ packed: PackedEntry[]; trace: PackTraceDraft }> {
    const limits = given ?? (await this.runLimits(workspaceId));
    const trace: PackTraceDraft = {
      query: input.query.trim(),
      seedModuleIds: [],
      neighbourModuleIds: [],
      topK: limits.topK,
      tokenBudget: limits.tokenBudget,
      tokensGiven: 0,
      searchFailed: false,
      candidates: [],
    };
    const issue = await this.prisma.issue.findFirst({
      where: { id: input.issueId, deleted: null, team: { workspaceId } },
      select: { moduleIds: true },
    });

    if (!issue) {
      return { packed: [], trace };
    }

    const seeds = await this.seedsFor(workspaceId, { issueId: input.issueId });
    trace.seedModuleIds = seeds?.modules ?? [];
    trace.neighbourModuleIds = seeds?.neighbours ?? [];

    // Served entries: standing, or consolidated as a page's evidence. A
    // consolidated entry is packed too, conventions pinned included: its fact
    // is in a page body, and page bodies are not packed, so leaving it out
    // would retire it for runs.
    const live: Prisma.PageEntryWhereInput = {
      status: { in: SERVED_STATUSES },
      deleted: null,
      ...liveEntryIn(workspaceId),
    };

    const conventions = issue.moduleIds.length
      ? await this.prisma.pageEntry.findMany({
          where: {
            ...live,
            kind: PageEntryKindEnum.CONVENTION,
            moduleIds: { hasSome: issue.moduleIds },
          },
          orderBy: [
            { verifiedAt: { sort: 'desc', nulls: 'last' } },
            { createdAt: 'desc' },
          ],
          take: MAX_PACKED_CONVENTIONS,
          select: PACKED_ENTRY_SELECT,
        })
      : [];

    const conventionIds = new Set(conventions.map((entry) => entry.id));
    const search = await this.rankedEntryIds(workspaceId, input, seeds);
    trace.searchFailed = search.failed;
    const ranked = search.ids.filter((id) => !conventionIds.has(id));

    const rows = ranked.length
      ? await this.prisma.pageEntry.findMany({
          where: { ...live, id: { in: ranked } },
          select: PACKED_ENTRY_SELECT,
        })
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const nearness = (moduleIds: string[]): KnowledgePackNearness =>
      moduleIds.some((id) => trace.seedModuleIds.includes(id))
        ? 'SEED'
        : moduleIds.some((id) => trace.neighbourModuleIds.includes(id))
          ? 'NEIGHBOUR'
          : 'NONE';

    // Each entry considered, with the entry to pack when it is kept.
    const considered: Array<{
      candidate: KnowledgePackCandidate;
      entry: PackedEntry | null;
    }> = conventions.map((row) => {
      const entry = packedEntry(row);
      const candidate: KnowledgePackCandidate = {
        entryId: row.id,
        source: 'CONVENTION',
        searchRank: null,
        nearness: 'SEED',
        trust: entry.trust,
        tokens: packedTokens(entry),
        given: false,
        order: null,
        dropped: null,
      };

      return { candidate, entry };
    });

    let relevant = 0;

    ranked.forEach((id) => {
      const row = byId.get(id);
      const entry = row ? packedEntry(row) : null;
      const dropped = !entry
        ? KnowledgePackDropEnum.NOT_LIVE
        : !PACKABLE_TRUST.includes(entry.trust)
          ? KnowledgePackDropEnum.NOT_TRUSTED
          : relevant >= limits.topK
            ? KnowledgePackDropEnum.TOP_K
            : null;

      if (!dropped) {
        relevant += 1;
      }

      const candidate: KnowledgePackCandidate = {
        entryId: id,
        source: 'SEARCH',
        searchRank: search.ids.indexOf(id) + 1,
        nearness: row ? nearness(row.moduleIds ?? []) : 'NONE',
        trust: entry?.trust ?? null,
        tokens: entry ? packedTokens(entry) : null,
        given: false,
        order: null,
        dropped,
      };

      considered.push({ candidate, entry: dropped ? null : entry });
    });

    const packed: PackedEntry[] = [];

    for (const { candidate, entry } of considered) {
      if (!entry) {
        continue;
      }

      const cost = candidate.tokens ?? packedTokens(entry);

      if (trace.tokensGiven + cost > limits.tokenBudget) {
        candidate.dropped = KnowledgePackDropEnum.BUDGET;
        continue;
      }

      packed.push(entry);
      trace.tokensGiven += cost;
      candidate.given = true;
      candidate.order = packed.length;
    }

    trace.candidates = considered.map(({ candidate }) => candidate);

    return { packed, trace };
  }

  /** The workspace's limits on the knowledge a run is handed. */
  private async runLimits(workspaceId: string): Promise<RunKnowledgeLimits> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { preferences: true },
    });
    const settings = knowledgeSettings(workspace?.preferences);

    return {
      topK: settings.contextTopK,
      tokenBudget: settings.contextTokenBudget,
    };
  }

  /**
   * Stores how a pack was chosen. Best effort, like every other record of
   * demand: a run or a `load_context` call is not failed over bookkeeping.
   */
  async recordTrace(
    workspaceId: string,
    draft: PackTraceDraft,
    about: {
      via: 'CONTEXT_PACK' | 'LOAD_CONTEXT';
      agentRunId?: string;
      arm?: 'TREATMENT' | 'HOLDOUT' | null;
      issueId?: string;
      userId?: string | null;
      sessionId?: string | null;
    },
  ): Promise<void> {
    try {
      await this.prisma.knowledgePackTrace.create({
        data: {
          workspaceId,
          via: about.via,
          agentRunId: about.agentRunId,
          arm: about.arm ?? undefined,
          issueId: about.issueId,
          userId: about.userId ?? undefined,
          sessionId: about.sessionId ?? undefined,
          query: draft.query.slice(0, 2000),
          seedModuleIds: draft.seedModuleIds,
          neighbourModuleIds: draft.neighbourModuleIds,
          topK: draft.topK,
          tokenBudget: draft.tokenBudget,
          tokensGiven: draft.tokensGiven,
          searchFailed: draft.searchFailed,
          candidates: draft.candidates as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.warn({
        message: `The trace of a context pack was not recorded: ${error}`,
        where: 'KnowledgeService.recordTrace',
      });
    }
  }

  /**
   * Records the entries packed into a run as served to it. Best-effort, like
   * every other record of demand: a run is not failed over bookkeeping.
   */
  async recordPacked(
    workspaceId: string,
    run: { id: string; agentUserId: string },
    entryIds: string[],
  ): Promise<void> {
    try {
      await this.pageEntriesService.recordServed(entryIds, {
        workspaceId,
        via: 'CONTEXT_PACK',
        agentRunId: run.id,
        userId: run.agentUserId,
      });
    } catch (error) {
      this.logger.warn({
        message: `The knowledge packed into run ${run.id} was not recorded: ${error}`,
        where: 'KnowledgeService.recordPacked',
      });
    }
  }

  /**
   * Entry ids by relevance to the query, seeded by the issue's modules, and
   * whether the search failed.
   */
  private async rankedEntryIds(
    workspaceId: string,
    input: { issueId: string; query: string },
    seeds?: { modules: string[]; neighbours: string[] },
  ): Promise<{ ids: string[]; failed: boolean }> {
    const query = input.query.trim();

    if (!query) {
      return { ids: [], failed: false };
    }

    try {
      const { hits } = await this.vectorService.searchKnowledge(
        workspaceId,
        query,
        { limit: PACK_SEARCH_LIMIT, boost: seeds },
      );

      return {
        ids: [
          ...new Set(
            hits
              .map((hit) => hit.entryId)
              .filter((id): id is string => Boolean(id)),
          ),
        ],
        failed: false,
      };
    } catch (error) {
      this.logger.warn({
        message: `The knowledge index could not be searched for a run, so it gets its modules' conventions only: ${error}`,
        where: 'KnowledgeService.rankedEntryIds',
      });

      return { ids: [], failed: true };
    }
  }

  /**
   * The modules to rank first, and their neighbours, for work that names
   * modules or an issue.
   *
   * One hop over the graph the workspace curates, and nothing inferred: the
   * modules named and the issue's modules are the seeds; the modules that
   * share a capability with a seed (or make up the issue's capability) and
   * the other modules of a seed's product — owned by it or linked to it — are
   * the neighbours. Every id is checked against this workspace, so a caller
   * cannot rank by another workspace's graph. No LLM is involved.
   */
  async seedsFor(
    workspaceId: string,
    seeds: KnowledgeSeeds,
  ): Promise<{ modules: string[]; neighbours: string[] } | undefined> {
    const named = [...(seeds.moduleIds ?? [])];
    const capabilityIds: string[] = [];

    if (seeds.issueId) {
      const issue = await this.prisma.issue.findFirst({
        where: { id: seeds.issueId, deleted: null, team: { workspaceId } },
        select: { moduleIds: true, capabilityId: true },
      });
      named.push(...(issue?.moduleIds ?? []));
      if (issue?.capabilityId) {
        capabilityIds.push(issue.capabilityId);
      }
    }

    if (named.length === 0 && capabilityIds.length === 0) {
      return undefined;
    }

    const modules = await this.prisma.module.findMany({
      where: { id: { in: named }, workspaceId, deleted: null },
      select: { id: true, ownerProductId: true },
    });
    const moduleIds = modules.map((productModule) => productModule.id);
    const productIds = [
      ...new Set(
        modules
          .map((productModule) => productModule.ownerProductId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const [capabilities, productModules] = await Promise.all([
      moduleIds.length || capabilityIds.length
        ? this.prisma.capability.findMany({
            where: {
              workspaceId,
              deleted: null,
              OR: [
                { moduleIds: { hasSome: moduleIds } },
                { id: { in: capabilityIds } },
              ],
            },
            select: { moduleIds: true },
          })
        : [],
      productIds.length
        ? this.prisma.module.findMany({
            where: {
              workspaceId,
              deleted: null,
              OR: [
                { ownerProductId: { in: productIds } },
                { linkedProductIds: { hasSome: productIds } },
              ],
            },
            select: { id: true },
          })
        : [],
    ]);

    // A capability's module list is plain ids, not a relation, so it can name
    // a module since deleted, or one no longer in this workspace. Checked like
    // every other seed rather than trusted.
    const listed = [
      ...new Set(capabilities.flatMap((capability) => capability.moduleIds)),
    ];
    const capabilityModules = listed.length
      ? await this.prisma.module.findMany({
          where: { id: { in: listed }, workspaceId, deleted: null },
          select: { id: true },
        })
      : [];

    const neighbours = [
      ...new Set([
        ...capabilityModules.map((productModule) => productModule.id),
        ...productModules.map((productModule) => productModule.id),
      ]),
    ].filter((id) => !moduleIds.includes(id));

    if (moduleIds.length === 0 && neighbours.length === 0) {
      return undefined;
    }

    return { modules: moduleIds, neighbours };
  }

  /** Near matches for a fact about to be written. Hints, never a veto. */
  async similarEntries(
    workspaceId: string,
    pageId: string | null,
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
    // An answered gap is closed. It stays in the table so that a repeat of the
    // question does not open a second issue.
    const gaps = await this.prisma.pageKnowledgeGap.findMany({
      where: { workspaceId, answeredAt: null },
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
   * Records what a search actually produced: usage counts and a use row per
   * entry served when it found something, a knowledge gap when it did not.
   *
   * Both are best-effort. A failure to record demand must not fail the read the
   * caller asked for — the counters steer ranking and decay, and being slightly
   * behind is survivable in a way that a failed recall is not.
   */
  private async recordDemand(
    workspaceId: string,
    query: string,
    served: KnowledgeSearchHit[],
    to: ServedTo,
    /** Whether finding nothing records the query as a knowledge gap. */
    { gap }: { gap: boolean } = { gap: true },
  ): Promise<void> {
    try {
      const entryIds = served
        .map((hit) => hit.entryId)
        .filter((id): id is string => Boolean(id));

      if (entryIds.length > 0) {
        await this.pageEntriesService.recordServed(entryIds, to);
      }

      if (gap && served.length === 0) {
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

function packedEntry(row: {
  id: string;
  content: string;
  scope: string | null;
  kind: string;
  status: string;
  verifiedAt: Date | null;
  createdAt: Date;
  citations: Parameters<typeof entryProof>[0]['citations'];
}): PackedEntry {
  return {
    entryId: row.id,
    kind: row.kind,
    scope: row.scope,
    body: row.content,
    writtenAt: row.createdAt.toISOString(),
    ...entryProof(row),
  };
}

/** What an entry costs in a prompt, rendered as the prompt renders it. */
function packedTokens(entry: PackedEntry): number {
  const text = `${entry.scope ?? ''}${entry.body}${describeProof(entry)}${entry.writtenAt}`;

  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateTokens(hit: KnowledgeSearchHit): number {
  // Provenance travels with the item, so it costs budget too — an agent
  // weighing a claim needs to see that a human confirmed it, and what it
  // cites, and pretending that metadata is free is how a budget silently
  // overruns.
  const cited = hit.citations?.length ? JSON.stringify(hit.citations) : '';
  const text = `${hit.title}\n${hit.content}\n${hit.scope ?? ''}\n${hit.trust ?? ''}${cited}`;

  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
