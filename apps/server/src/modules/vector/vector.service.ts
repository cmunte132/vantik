import { Injectable, OnModuleInit } from '@nestjs/common';
import { PageEntryStatusEnum, WorkflowCategoryEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';
import { Client as TypesenseClient } from 'typesense';

import {
  convertTiptapJsonToMarkdown,
  convertTiptapJsonToText,
} from 'common/utils/tiptap.utils';

import { IssueWithRelations } from 'modules/issues/issues.interface';
import { LoggerService } from 'modules/logger/logger.service';

import {
  INDEXED_STATUSES,
  ISSUE_QUERY_BY,
  IssueSearchHit,
  KNOWLEDGE_FACET_BY,
  KNOWLEDGE_GROUP_LIMIT,
  KNOWLEDGE_NEAR_MATCH_DISTANCE,
  KNOWLEDGE_SORT_BY,
  KnowledgeSearchHit,
  KnowledgeSearchResult,
  MAX_COMMENTS_TEXT_LENGTH,
  PAGE_QUERY_BY,
  RESOLUTION_SNIPPET_LENGTH,
  SIMILAR_ISSUE_DISTANCE_THRESHOLD,
  issueSchema,
  pageEmbedding,
  pageSchema,
  requiredIssueFields,
  requiredPageFields,
  typesenseEmbedding,
} from './vector.interface';

/**
 * Search runs entirely inside typesense, which generates embeddings in-process
 * with its built-in model. Nothing about an issue — title, description or
 * comments — is sent to a third-party service.
 */
@Injectable()
export class VectorService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private typesenseClient: TypesenseClient,
  ) {}

  private readonly logger: LoggerService = new LoggerService('VectorService');

  async onModuleInit() {
    // Search must not block server boot — typesense may still be starting
    // (or be entirely absent); collection setup is retried implicitly on the
    // next boot and errors are logged inside each ensure call.
    try {
      await this.createIssuesCollection();
      await this.createPagesCollection();
    } catch (error) {
      this.logger.error({
        message: `Unable to initialise typesense collections: ${error.message}`,
        where: `VectorService.onModuleInit`,
      });
    }
  }

  async createIssuesCollection() {
    await this.ensureCollection(
      'issues',
      () => ({
        ...issueSchema,
        fields: [...issueSchema.fields, typesenseEmbedding],
      }),
      requiredIssueFields,
      (workspaceId) => this.prefillIssuesData(workspaceId),
    );
  }

  async createPagesCollection() {
    await this.ensureCollection(
      'pages',
      () => ({
        ...pageSchema,
        fields: [...pageSchema.fields, pageEmbedding],
      }),
      requiredPageFields,
      (workspaceId) => this.prefillPagesData(workspaceId),
    );
  }

  /**
   * Creates a collection if it is absent, and rebuilds it if it is stale.
   *
   * The schema is not versioned server-side, so a collection created by an
   * older build is detected by the fields it is missing. Typesense's alter
   * endpoint cannot backfill values for new fields — least of all an embedding
   * — so a stale collection is dropped and rebuilt from Postgres instead. The
   * prefill is idempotent and is how the very first fill already works.
   *
   * Generalised over the collection because there are now two following this
   * same lifecycle, and a copy-paste of it would drift the moment one of them
   * grew a field.
   */
  private async ensureCollection(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildSchema: () => any,
    requiredFields: string[],
    prefill: (workspaceId: string) => Promise<void>,
  ) {
    let existing;
    try {
      existing = await this.typesenseClient.collections(name).retrieve();
    } catch (error) {
      if (error.httpStatus !== 404) {
        this.logger.error({
          message: `Error retrieving ${name} collection:`,
          where: `VectorService.ensureCollection`,
          error,
        });
        return;
      }
    }

    if (existing) {
      const presentFields = new Set(
        existing.fields.map((field: { name: string }) => field.name),
      );
      const missingFields = requiredFields.filter(
        (field) => !presentFields.has(field),
      );

      if (missingFields.length === 0) {
        this.logger.info({
          message: `${name} collection already exists`,
          where: `VectorService.ensureCollection`,
        });
        return;
      }

      this.logger.info({
        message: `${name} collection is missing ${missingFields.join(', ')} — recreating and re-indexing`,
        where: `VectorService.ensureCollection`,
      });
      await this.typesenseClient.collections(name).delete();
    }

    try {
      // A fresh copy of the schema each time — the embedding field is appended,
      // so mutating the shared object would double it on a second call.
      await this.typesenseClient.collections().create(buildSchema());
    } catch (createError) {
      // A previous create attempt may have succeeded server-side after the
      // client timed out — a duplicate-collection 409 is fine.
      if (createError.httpStatus !== 409) {
        this.logger.error({
          message: `Error creating ${name} collection:`,
          where: `VectorService.ensureCollection`,
          error: createError,
        });
        return;
      }
    }

    this.logger.info({
      message: `Created the ${name} collection`,
      where: `VectorService.ensureCollection`,
    });

    await this.reindexAllWorkspaces(prefill);
  }

  /** Re-indexes every workspace. Safe to call at any time. */
  async reindexAllWorkspaces(
    prefill: (workspaceId: string) => Promise<void> = (workspaceId) =>
      this.prefillIssuesData(workspaceId),
  ) {
    const workspaces = await this.prisma.workspace.findMany({
      where: { deleted: null },
      select: { id: true },
    });

    await Promise.all(workspaces.map((workspace) => prefill(workspace.id)));

    this.logger.info({
      message: 'Prefilled data for all workspaces',
      where: `VectorService.reindexAllWorkspaces`,
    });
  }

  async createIssueEmbedding(issue: IssueWithRelations) {
    // Generate the issue number by combining team identifier and issue number
    const issueNumber = `${issue.team.identifier}-${issue.number}`;

    const [stateCategory, { commentsText, resolutionText }] = await Promise.all(
      [this.getStateCategory(issue.stateId), this.getCommentTexts(issue)],
    );

    // The embedding itself is generated by typesense from the fields listed in
    // `typesenseEmbedding.embed.from`, so only the document is upserted here.
    await this.typesenseClient
      .collections('issues')
      .documents()
      .upsert({
        id: issue.id,
        teamId: issue.teamId,
        number: issue.number,
        numberString: issue.number.toString(),
        issueNumber,
        title: issue.title,
        description: issue.description ?? '',
        descriptionString: convertTiptapJsonToText(issue.description),
        stateId: issue.stateId,
        stateCategory,
        commentsText,
        resolutionText,
        workspaceId: issue.team.workspaceId,
        assigneeId: issue.assigneeId ?? '',
      });
  }

  /**
   * Removes an issue from the search index.
   *
   * Issues are soft-deleted in postgres, but the index has no notion of that,
   * so without this a deleted issue stays permanently searchable and an agent
   * looking for prior art gets told a problem was solved by an issue that no
   * longer exists.
   */
  async deleteIssueEmbedding(issueId: string) {
    try {
      await this.typesenseClient
        .collections('issues')
        .documents(issueId)
        .delete();
    } catch (error) {
      // A missing document is the desired end state, not a failure: an issue
      // deleted before it was ever indexed would otherwise fail the job and be
      // retried forever.
      if (error.httpStatus === 404) {
        return;
      }
      throw error;
    }
  }

  private async getStateCategory(stateId: string): Promise<string> {
    if (!stateId) {
      return '';
    }

    const state = await this.prisma.workflow.findUnique({
      where: { id: stateId },
      select: { category: true },
    });

    return state?.category ?? '';
  }

  /**
   * Builds the searchable comment text for an issue, plus a best guess at the
   * comment that explains the resolution: the last top-level comment posted at
   * or before the issue's most recent transition into a COMPLETED state.
   */
  private async getCommentTexts(issue: IssueWithRelations) {
    const comments = await this.prisma.issueComment.findMany({
      where: { issueId: issue.id, deleted: null },
      orderBy: { createdAt: 'asc' },
      select: { body: true, createdAt: true, parentId: true },
    });

    if (comments.length === 0) {
      return { commentsText: '', resolutionText: '' };
    }

    const texts = comments.map((comment) => ({
      ...comment,
      text: convertTiptapJsonToText(comment.body),
    }));

    // Keep the newest comments when the cap is hit — recent discussion is
    // where a resolution is most likely to be described.
    let commentsText = texts.map(({ text }) => text).join('\n\n');
    if (commentsText.length > MAX_COMMENTS_TEXT_LENGTH) {
      commentsText = commentsText.slice(-MAX_COMMENTS_TEXT_LENGTH);
    }

    const { completedAt, isCompleted } = await this.getCompletion(issue);
    const topLevel = texts.filter((comment) => !comment.parentId);

    // Prefer the last comment written at or before the issue was closed, so
    // chatter added afterwards does not masquerade as the resolution. When the
    // issue is closed but nothing qualifies — the explanation landed moments
    // after the state change, which is the common way of working — fall back
    // to the latest comment rather than reporting no resolution at all.
    const resolutionComment =
      (completedAt
        ? topLevel.filter((comment) => comment.createdAt <= completedAt).pop()
        : undefined) ??
      (isCompleted ? topLevel[topLevel.length - 1] : undefined);

    return { commentsText, resolutionText: resolutionComment?.text ?? '' };
  }

  private async getCompletion(
    issue: IssueWithRelations,
  ): Promise<{ completedAt: Date | null; isCompleted: boolean }> {
    const completedStates = await this.prisma.workflow.findMany({
      where: {
        teamId: issue.teamId,
        category: WorkflowCategoryEnum.COMPLETED,
        deleted: null,
      },
      select: { id: true },
    });

    if (completedStates.length === 0) {
      return { completedAt: null, isCompleted: false };
    }

    const completedStateIds = completedStates.map((state) => state.id);

    const transition = await this.prisma.issueHistory.findFirst({
      where: {
        issueId: issue.id,
        deleted: null,
        toStateId: { in: completedStateIds },
      },
      orderBy: { updatedAt: 'desc' },
      // `upsertIssueHistory` folds consecutive changes by the same user into
      // one row, so `createdAt` is when that group of changes started — often
      // issue creation — while `updatedAt` is when the state actually moved.
      select: { updatedAt: true },
    });

    return {
      completedAt: transition?.updatedAt ?? null,
      isCompleted: completedStateIds.includes(issue.stateId),
    };
  }

  async searchEmbeddings(
    workspaceId: string,
    searchQuery: string,
    limit: number,
    vectorDistance: number = 0.8,
    stateCategories: string[] = [],
  ) {
    // Set a default value of 0.8 for vectorDistance if it is NaN
    if (isNaN(vectorDistance)) {
      vectorDistance = 0.8;
    }

    // Define search parameters for Typesense multiSearch. `q` must carry the
    // actual query text: with the wildcard `*` typesense skips both the
    // keyword match and the query embedding, and simply returns every document
    // in the workspace unranked.
    const searchParameters = {
      searches: [
        {
          collection: 'issues',
          q: searchQuery,
          query_by: ISSUE_QUERY_BY,
          filter_by: buildFilterBy(workspaceId, stateCategories),
          sort_by: '_text_match:desc',
          vector_query: `embeddings:([], distance_threshold:${vectorDistance})`,
          exclude_fields: 'embeddings',
          page: 1,
          per_page: limit,
        },
      ],
    };

    // Perform multiSearch using Typesense client
    const searchResults =
      await this.typesenseClient.multiSearch.perform(searchParameters);

    return this.dropDeletedIssues(mapSearchHits(searchResults));
  }

  /**
   * Drops hits whose issue no longer exists.
   *
   * The index is a cache and postgres is the truth. Removal is queued when an
   * issue is deleted, but a failed job, a restore from an older snapshot, or a
   * reindex against a stale collection all leave documents behind — and a
   * search that confidently reports a deleted issue is worse than one that
   * misses it. One indexed lookup per search is a cheap guarantee.
   */
  private async dropDeletedIssues(
    hits: IssueSearchHit[],
  ): Promise<IssueSearchHit[]> {
    if (hits.length === 0) {
      return hits;
    }

    const liveIssues = await this.prisma.issue.findMany({
      where: { id: { in: hits.map((hit) => hit.id) }, deleted: null },
      select: { id: true },
    });
    const liveIds = new Set(liveIssues.map((issue) => issue.id));

    const live = hits.filter((hit) => liveIds.has(hit.id));

    if (live.length !== hits.length) {
      this.logger.info({
        message: `Search index is stale: dropped ${hits.length - live.length} hit(s) for deleted issues`,
        where: `VectorService.dropDeletedIssues`,
      });
    }

    return live;
  }

  async similarIssues(workspaceId: string, issueId: string) {
    // Prepare the search request for Typesense
    const searchRequests = {
      searches: [
        {
          collection: 'issues',
          q: '*',
          // Anchored on an existing document, so the wildcard `q` is correct
          // here — the vector comes from the issue, not from query text.
          vector_query: `embeddings:([], id:${issueId}, distance_threshold:${SIMILAR_ISSUE_DISTANCE_THRESHOLD})`,
          filter_by: buildFilterBy(workspaceId, []),
          exclude_fields: 'embeddings',
          page: 1,
        },
      ],
    };

    // Perform the multi-search request to Typesense
    const searchResults =
      await this.typesenseClient.multiSearch.perform(searchRequests);

    // The vector query already excludes anything past the distance threshold,
    // so the hits come back ranked by similarity.
    return this.dropDeletedIssues(mapSearchHits(searchResults));
  }

  // ------------------------------------------------------- knowledge bank

  /**
   * Indexes a page body as one document.
   *
   * The body is indexed as text rather than as tiptap JSON, for the same reason
   * issue descriptions are: nobody searches for `{"type":"doc"`.
   */
  async indexPage(page: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string;
    updatedAt: Date;
  }) {
    await this.typesenseClient
      .collections('pages')
      .documents()
      .upsert({
        id: `page:${page.id}`,
        workspaceId: page.workspaceId,
        kind: 'page',
        pageId: page.id,
        pageTitle: page.title,
        entryId: '',
        title: page.title,
        content: convertTiptapJsonToText(page.description),
        scope: '',
        // A page body is the agreed narrative rather than a claim awaiting
        // triage, so it carries the served status directly.
        status: PageEntryStatusEnum.STANDING,
        sourceUserId: '',
        verified: true,
        scoped: false,
        retrievalCount: 0,
        updatedBucket: monthBucket(page.updatedAt),
        updatedAt: page.updatedAt.getTime(),
      });
  }

  /** Indexes one asserted fact, with the provenance a reader needs to weigh it. */
  async indexEntry(entry: {
    id: string;
    content: string;
    scope: string | null;
    status: string;
    sourceUserId: string | null;
    verifiedAt: Date | null;
    retrievalCount: number;
    updatedAt: Date;
    pageId: string;
    page: { title: string; workspaceId: string };
  }) {
    await this.typesenseClient
      .collections('pages')
      .documents()
      .upsert({
        id: `entry:${entry.id}`,
        workspaceId: entry.page.workspaceId,
        kind: 'entry',
        pageId: entry.pageId,
        pageTitle: entry.page.title,
        entryId: entry.id,
        title: entry.page.title,
        content: entry.content,
        scope: entry.scope ?? '',
        status: entry.status,
        sourceUserId: entry.sourceUserId ?? '',
        verified: Boolean(entry.verifiedAt),
        scoped: Boolean(entry.scope),
        retrievalCount: entry.retrievalCount,
        updatedBucket: monthBucket(entry.updatedAt),
        updatedAt: entry.updatedAt.getTime(),
      });
  }

  /**
   * Removes a page or entry from the index.
   *
   * Pages and entries are soft-deleted in postgres and the index has no notion
   * of that. A deleted page that stays searchable is worse here than it is for
   * issues: an agent served a retracted fact acts on it, having been told the
   * workspace believes it.
   */
  async deleteKnowledgeDocument(documentId: string) {
    try {
      await this.typesenseClient
        .collections('pages')
        .documents(documentId)
        .delete();
    } catch (error) {
      // A missing document is the desired end state, not a failure.
      if (error.httpStatus === 404) {
        return;
      }
      throw error;
    }
  }

  /**
   * Searches the bank: page bodies and standing entries, grouped so no single
   * page can dominate, and ranked inside the query rather than in Node.
   */
  async searchKnowledge(
    workspaceId: string,
    query: string,
    options: {
      limit?: number;
      scope?: string;
      /** Restrict to one page. Filtered in the query, not after it. */
      pageId?: string;
      /** Include statuses other than STANDING. Triage surfaces only. */
      includeStatuses?: string[];
      vectorDistance?: number;
    } = {},
  ): Promise<KnowledgeSearchResult> {
    const searchParameters = {
      searches: [
        {
          collection: 'pages',
          q: query,
          query_by: PAGE_QUERY_BY,
          filter_by: buildKnowledgeFilterBy(workspaceId, options),
          sort_by: KNOWLEDGE_SORT_BY,
          facet_by: KNOWLEDGE_FACET_BY,
          // The control that holds when every other gate has failed: fifty
          // entries on one page contribute at most three documents.
          group_by: 'pageId',
          group_limit: KNOWLEDGE_GROUP_LIMIT,
          vector_query: `embeddings:([], distance_threshold:${
            options.vectorDistance ?? 0.8
          })`,
          exclude_fields: 'embeddings',
          page: 1,
          per_page: options.limit ?? 20,
        },
      ],
    };

    const searchResults =
      await this.typesenseClient.multiSearch.perform(searchParameters);

    const result = mapKnowledgeResults(searchResults);

    return { ...result, hits: await this.dropDeletedKnowledge(result.hits) };
  }

  /**
   * Entries that look like the one about to be written.
   *
   * Returned to the caller, never used to reject a write. Measured against the
   * live index, cosine distance from this model did not reliably rank an exact
   * restatement above an unrelated document — an LLM comparing two short facts
   * is far better at that judgment than a threshold, so this hands it the
   * candidates and lets it decide.
   */
  async findSimilarEntries(
    workspaceId: string,
    pageId: string,
    content: string,
  ): Promise<KnowledgeSearchHit[]> {
    const { hits } = await this.searchKnowledge(workspaceId, content, {
      limit: 5,
      vectorDistance: KNOWLEDGE_NEAR_MATCH_DISTANCE,
      // Narrowed in the query rather than afterwards. Grouping caps each page
      // at three documents and this asks for five groups, so a page-scoped
      // filter applied in Node returns nothing at all whenever five other pages
      // happen to rank above the one being written to — which is silently no
      // dedup check on exactly the busiest workspaces.
      pageId,
      // Proposed entries are indexed for this query and served by no other:
      // ten agents appending the same untriaged fact is the flood this exists
      // to catch, and every one of those claims is PROPOSED.
      includeStatuses: [
        PageEntryStatusEnum.STANDING,
        PageEntryStatusEnum.PROPOSED,
      ],
    });

    return hits.filter((hit) => hit.entryId);
  }

  /**
   * Drops hits whose page or entry no longer exists.
   *
   * The index is a cache and postgres is the truth. Serving a fact the
   * workspace has deleted is the failure that loses trust in the bank, and one
   * indexed lookup per search is a cheap guarantee against it.
   */
  private async dropDeletedKnowledge(
    hits: KnowledgeSearchHit[],
  ): Promise<KnowledgeSearchHit[]> {
    if (hits.length === 0) {
      return hits;
    }

    const [livePages, liveEntries] = await Promise.all([
      this.prisma.page.findMany({
        where: { id: { in: hits.map((hit) => hit.pageId) }, deleted: null },
        select: { id: true },
      }),
      this.prisma.pageEntry.findMany({
        where: {
          id: { in: hits.map((hit) => hit.entryId).filter(Boolean) },
          deleted: null,
        },
        select: { id: true },
      }),
    ]);

    const livePageIds = new Set(livePages.map((page) => page.id));
    const liveEntryIds = new Set(liveEntries.map((entry) => entry.id));

    const live = hits.filter(
      (hit) =>
        livePageIds.has(hit.pageId) &&
        (!hit.entryId || liveEntryIds.has(hit.entryId)),
    );

    if (live.length !== hits.length) {
      this.logger.info({
        message: `Knowledge index is stale: dropped ${hits.length - live.length} hit(s) for deleted pages or entries`,
        where: `VectorService.dropDeletedKnowledge`,
      });
    }

    return live;
  }

  async prefillPagesData(workspaceId: string) {
    const pages = await this.prisma.page.findMany({
      where: { workspaceId, deleted: null },
    });

    for (const page of pages) {
      await this.indexPage(page);
    }

    // The same statuses the incremental path indexes, or a rebuild would
    // quietly narrow the collection and take the duplicate check with it.
    const entries = await this.prisma.pageEntry.findMany({
      where: {
        deleted: null,
        status: { in: INDEXED_STATUSES },
        page: { workspaceId, deleted: null },
      },
      include: { page: { select: { title: true, workspaceId: true } } },
    });

    for (const entry of entries) {
      await this.indexEntry(entry);
    }

    this.logger.info({
      message: `Prefilled ${pages.length} pages and ${entries.length} entries for workspaceId: ${workspaceId}`,
      where: `VectorService.prefillPagesData`,
    });
  }

  async prefillIssuesData(workspaceId: string) {
    const issues = await this.prisma.issue.findMany({
      where: { team: { workspaceId }, deleted: null },
      include: { team: true },
    });

    for (const issue of issues) {
      await this.createIssueEmbedding(issue);
    }

    this.logger.info({
      message: `Prefilled all issues data into vector for workspaceId: ${workspaceId}`,
      where: `VectorService.prefillIssuesData`,
    });
  }
}

const ALLOWED_STATE_CATEGORIES = new Set(Object.values(WorkflowCategoryEnum));

// Matches the standard UUID format (e.g. UUID v4) produced by the database.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildFilterBy(workspaceId: string, stateCategories: string[]): string {
  if (!UUID_REGEX.test(workspaceId)) {
    throw new Error('Invalid workspaceId format');
  }

  const filters = [`workspaceId:=\`${workspaceId}\``];

  const allowedCategories = stateCategories.filter((c) =>
    ALLOWED_STATE_CATEGORIES.has(c as WorkflowCategoryEnum),
  );

  if (allowedCategories.length > 0) {
    filters.push(
      `stateCategory:=[${allowedCategories.map((c) => `\`${c}\``).join(',')}]`,
    );
  }

  return filters.join(' && ');
}

/**
 * The read-side half of the status guarantee.
 *
 * `PROPOSED`, `CONSOLIDATED`, `SUPERSEDED`, `DISPUTED` and `ARCHIVED` must
 * never reach a caller: getting this wrong means agents are served facts the
 * workspace has already rejected, replaced, or folded into a page body — and
 * the duplicate is as damaging as the retraction, because two copies of one
 * fact read as two independent confirmations of it.
 *
 * Callers may widen the status set for triage surfaces, but never past the
 * workspace filter, and the same `UUID_REGEX` guard that stops filter injection
 * on the issues collection applies here.
 */
function buildKnowledgeFilterBy(
  workspaceId: string,
  options: { scope?: string; pageId?: string; includeStatuses?: string[] } = {},
): string {
  if (!UUID_REGEX.test(workspaceId)) {
    throw new Error('Invalid workspaceId format');
  }

  if (options.pageId && !UUID_REGEX.test(options.pageId)) {
    throw new Error('Invalid pageId format');
  }

  const statuses = (
    options.includeStatuses?.length
      ? options.includeStatuses
      : [PageEntryStatusEnum.STANDING]
  ).filter((status) =>
    Object.values(PageEntryStatusEnum).includes(status as PageEntryStatusEnum),
  );

  const filters = [
    `workspaceId:=\`${workspaceId}\``,
    `status:=[${statuses.map((status) => `\`${status}\``).join(',')}]`,
  ];

  if (options.pageId) {
    filters.push(`pageId:=\`${options.pageId}\``);
  }

  if (options.scope) {
    // Backticks quote the value, so a scope containing `&&` or a colon cannot
    // close the literal and append a filter of the caller's choosing.
    filters.push(`scope:=\`${options.scope}\``);
  }

  return filters.join(' && ');
}

/** A coarse recency facet — one value per month, not one per timestamp. */
function monthBucket(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Flattens a grouped Typesense response into hits plus facet counts.
 *
 * Grouped searches return `grouped_hits` rather than `hits`, which is exactly
 * the shape a Node-side re-sort would flatten and then reorder — undoing the
 * per-page cap. The order typesense returns is the order that is served.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapKnowledgeResults(searchResults: any): KnowledgeSearchResult {
  const result = searchResults.results?.[0] ?? {};

  const rawHits = result.grouped_hits
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.grouped_hits.flatMap((group: any) => group.hits ?? [])
    : (result.hits ?? []);

  const facets: Record<string, Record<string, number>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const facet of result.facet_counts ?? []) {
    facets[facet.field_name] = (facet.counts ?? []).reduce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (counts: Record<string, number>, entry: any) => {
        counts[entry.value] = entry.count;
        return counts;
      },
      {},
    );
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hits: rawHits.map(({ document, vector_distance }: any) => ({
      id: document.id,
      kind: document.kind,
      pageId: document.pageId,
      pageTitle: document.pageTitle,
      entryId: document.entryId || null,
      title: document.title,
      content: document.content,
      scope: document.scope || null,
      status: document.status,
      sourceUserId: document.sourceUserId || null,
      verified: Boolean(document.verified),
      retrievalCount: document.retrievalCount ?? 0,
      distance: vector_distance,
      relevanceScore:
        vector_distance === undefined ? undefined : 1 - vector_distance,
    })),
    facets,
    found: result.found ?? rawHits.length,
  };
}

/** Flattens a Typesense multiSearch response into plain issue hits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSearchHits(searchResults: any): IssueSearchHit[] {
  return (
    searchResults.results
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map(({ hits }: any) =>
        hits?.map(
          ({
            document: {
              id,
              title,
              description,
              stateId,
              stateCategory,
              resolutionText,
              teamId,
              number,
              issueNumber,
              descriptionString,
              workspaceId,
              assigneeId,
            },
            vector_distance,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }: any) => ({
            id,
            title,
            description,
            // Search results are part of the same markdown boundary as the
            // issue endpoints: a caller should never have to parse tiptap JSON
            // out of `description` to read what a hit actually says.
            descriptionMarkdown: convertTiptapJsonToMarkdown(description ?? ''),
            descriptionString,
            stateId,
            stateCategory: stateCategory ?? '',
            resolutionSnippet: (resolutionText ?? '').slice(
              0,
              RESOLUTION_SNIPPET_LENGTH,
            ),
            teamId,
            number,
            issueNumber,
            workspaceId,
            assigneeId,
            distance: vector_distance,
            // Typesense reports a cosine distance (0 = identical); callers
            // that rank or weight results want it the other way round.
            relevanceScore:
              vector_distance === undefined ? undefined : 1 - vector_distance,
          }),
        ),
      )
      .flat()
      .filter(Boolean)
  );
}
