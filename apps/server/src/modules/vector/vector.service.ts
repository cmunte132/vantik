import { Injectable, OnModuleInit } from '@nestjs/common';
import { WorkflowCategoryEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';
import { Client as TypesenseClient } from 'typesense';

import {
  convertTiptapJsonToMarkdown,
  convertTiptapJsonToText,
} from 'common/utils/tiptap.utils';

import { IssueWithRelations } from 'modules/issues/issues.interface';
import { LoggerService } from 'modules/logger/logger.service';

import {
  ISSUE_QUERY_BY,
  IssueSearchHit,
  MAX_COMMENTS_TEXT_LENGTH,
  RESOLUTION_SNIPPET_LENGTH,
  SIMILAR_ISSUE_DISTANCE_THRESHOLD,
  issueSchema,
  requiredIssueFields,
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
    // next boot and errors are logged inside createIssuesCollection.
    try {
      await this.createIssuesCollection();
    } catch (error) {
      this.logger.error({
        message: `Unable to initialise typesense issues collection: ${error.message}`,
        where: `VectorService.onModuleInit`,
      });
    }
  }

  /**
   * The schema is not versioned server-side, so a collection created by an
   * older build is detected by the fields it is missing. Typesense's alter
   * endpoint cannot backfill values for new fields, so a stale collection is
   * dropped and rebuilt from Postgres instead — `prefillIssuesData` is
   * idempotent and is how the very first fill already works.
   */
  async createIssuesCollection() {
    let existing;
    try {
      existing = await this.typesenseClient.collections('issues').retrieve();
    } catch (error) {
      if (error.httpStatus !== 404) {
        this.logger.error({
          message: 'Error retrieving issues collection:',
          where: `VectorService.createIssuesCollection`,
          error,
        });
        return;
      }
    }

    if (existing) {
      const presentFields = new Set(
        existing.fields.map((field: { name: string }) => field.name),
      );
      const missingFields = requiredIssueFields.filter(
        (field) => !presentFields.has(field),
      );

      if (missingFields.length === 0) {
        this.logger.info({
          message: 'Issues collection already exists',
          where: `VectorService.createIssuesCollection`,
        });
        return;
      }

      this.logger.info({
        message: `Issues collection is missing ${missingFields.join(', ')} — recreating and re-indexing`,
        where: `VectorService.createIssuesCollection`,
      });
      await this.typesenseClient.collections('issues').delete();
    }

    try {
      await this.typesenseClient.collections().create(this.buildIssueSchema());
    } catch (createError) {
      // A previous create attempt may have succeeded server-side after the
      // client timed out — a duplicate-collection 409 is fine.
      if (createError.httpStatus !== 409) {
        this.logger.error({
          message: 'Error creating issues collection:',
          where: `VectorService.createIssuesCollection`,
          error: createError,
        });
        return;
      }
    }

    this.logger.info({
      message: 'Created an issue collection',
      where: `VectorService.createIssuesCollection`,
    });

    await this.reindexAllWorkspaces();
  }

  /** Re-indexes every workspace. Safe to call at any time. */
  async reindexAllWorkspaces() {
    const workspaces = await this.prisma.workspace.findMany({
      where: { deleted: null },
      select: { id: true },
    });

    await Promise.all(
      workspaces.map((workspace) => this.prefillIssuesData(workspace.id)),
    );

    this.logger.info({
      message: 'Prefilled data for all workspaces',
      where: `VectorService.reindexAllWorkspaces`,
    });
  }

  /**
   * A fresh copy of the schema each time — the embedding field is appended, so
   * mutating the shared object would double it on a second call.
   */
  private buildIssueSchema() {
    return {
      ...issueSchema,
      fields: [...issueSchema.fields, typesenseEmbedding],
    };
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

function buildFilterBy(workspaceId: string, stateCategories: string[]): string {
  // Strip backticks from workspaceId to prevent escaping out of the backtick
  // quoting. Workspace IDs are UUIDs so this is purely defensive.
  const safeWorkspaceId = workspaceId.replace(/`/g, '');
  const filters = [`workspaceId:=\`${safeWorkspaceId}\``];

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
