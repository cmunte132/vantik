import { Injectable, OnModuleInit } from '@nestjs/common';
import { WorkflowCategoryEnum } from '@vantikhq/types';
import { CohereClient } from 'cohere-ai';
import { PrismaService } from 'nestjs-prisma';
import { Client as TypesenseClient } from 'typesense';

import { convertTiptapJsonToText } from 'common/utils/tiptap.utils';

import { IssueWithRelations } from 'modules/issues/issues.interface';
import { LoggerService } from 'modules/logger/logger.service';

import {
  IssueSearchHit,
  MAX_COMMENTS_TEXT_LENGTH,
  RESOLUTION_SNIPPET_LENGTH,
  cohereEmbedding,
  issueSchema,
  requiredIssueFields,
  typesenseEmbedding,
} from './vector.interface';

@Injectable()
export class VectorService implements OnModuleInit {
  private readonly cohereClient: CohereClient;
  private readonly isCohere: boolean;
  private readonly embedModel: string;
  private readonly rerankModel: string;

  constructor(
    private prisma: PrismaService,
    private typesenseClient: TypesenseClient,
  ) {
    this.cohereClient = new CohereClient({
      token: process.env.COHERE_API_KEY,
    });
    this.isCohere = process.env.COHERE_API_KEY ? true : false;
    this.embedModel = process.env.COHERE_EMBED_MODEL || 'embed-english-v3.0';
    this.rerankModel = process.env.COHERE_RERANK_MODEL || 'rerank-english-v3.0';
  }

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
      fields: [
        ...issueSchema.fields,
        this.isCohere ? cohereEmbedding : typesenseEmbedding,
      ],
    };
  }

  async createIssueEmbedding(issue: IssueWithRelations) {
    // Generate the issue number by combining team identifier and issue number
    const issueNumber = `${issue.team.identifier}-${issue.number}`;

    const [stateCategory, { commentsText, resolutionText }] = await Promise.all(
      [this.getStateCategory(issue.stateId), this.getCommentTexts(issue)],
    );

    // Prepare the input text for embedding by concatenating issue number,
    // title, description and the discussion that followed
    const inputText = `${issueNumber}_${issue.title}_${convertTiptapJsonToText(issue.description)}_${commentsText}`;

    let embedding: Record<string, Float32Array>;
    if (this.isCohere) {
      // Generate embeddings using Cohere API
      const cohereEmbed = await this.cohereClient.embed({
        texts: [inputText],
        model: this.embedModel,
        inputType: 'search_query',
        embeddingTypes: ['float'],
      });

      // Extract the float embeddings from the Cohere response
      embedding = cohereEmbed.embeddings as Record<string, Float32Array>;
    }

    // Upsert the issue document in the Typesense 'issues' collection
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
        // Include the float embeddings in the document if using Cohere
        ...(this.isCohere && { embeddings: embedding.float[0] }),
      });
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

    const completedAt = await this.getLastCompletedAt(issue);
    const resolutionComment = completedAt
      ? texts
          .filter(
            (comment) => !comment.parentId && comment.createdAt <= completedAt,
          )
          .pop()
      : undefined;

    return { commentsText, resolutionText: resolutionComment?.text ?? '' };
  }

  private async getLastCompletedAt(
    issue: IssueWithRelations,
  ): Promise<Date | null> {
    const completedStates = await this.prisma.workflow.findMany({
      where: {
        teamId: issue.teamId,
        category: WorkflowCategoryEnum.COMPLETED,
        deleted: null,
      },
      select: { id: true },
    });

    if (completedStates.length === 0) {
      return null;
    }

    const transition = await this.prisma.issueHistory.findFirst({
      where: {
        issueId: issue.id,
        deleted: null,
        toStateId: { in: completedStates.map((state) => state.id) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    return transition?.createdAt ?? null;
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

    let queryBy =
      'numberString,issueNumber,title,descriptionString,commentsText,embeddings';
    let embedding: Record<string, Float32Array>;
    let vectorQuery = `embeddings:([], distance_threshold:${vectorDistance})`;
    // Set a relevance threshold to filter out low-relevance results
    const relevanceThreshold = 1 - vectorDistance;

    // If using Cohere, embed the search query and update queryBy and vectorQuery
    if (this.isCohere) {
      const cohereEmbed = await this.cohereClient.embed({
        texts: [searchQuery],
        model: this.embedModel,
        inputType: 'search_query',
        embeddingTypes: ['float'],
      });

      embedding = cohereEmbed.embeddings as Record<string, Float32Array>;
      queryBy = 'numberString,issueNumber,title,descriptionString,commentsText';
      vectorQuery = `embeddings:([${embedding.float[0]}])`;
    }

    // Define search parameters for Typesense multiSearch
    const searchParameters = {
      searches: [
        {
          collection: 'issues',
          q: '*',
          query_by: queryBy,
          filter_by: buildFilterBy(workspaceId, stateCategories),
          sort_by: '_text_match:desc',
          vector_query: vectorQuery,
          exclude_fields: 'embeddings',
          page: 1,
          per_page: limit,
        },
      ],
    };

    // Perform multiSearch using Typesense client
    const searchResults =
      await this.typesenseClient.multiSearch.perform(searchParameters);

    // Extract relevant fields from search results
    const hits = mapSearchHits(searchResults);

    // If using Cohere and there are multiple hits, rerank the results
    if (this.isCohere && hits.length > 1 && searchQuery) {
      // Create an array of documents containing the issue number, title, and description
      const documents = hits.map((hit) => ({
        text: `${hit.issueNumber}_${hit.title}_${hit.descriptionString}`,
      }));

      // Rerank the documents using Cohere's rerank API
      const rerankResult = await this.cohereClient.rerank({
        documents,
        query: searchQuery,
        topN: hits.length,
        model: this.rerankModel,
      });

      // Filter and map the reranked results based on the relevance threshold
      const rerankedHits = rerankResult.results
        .filter(({ relevanceScore }) => relevanceScore >= relevanceThreshold)
        .map(({ index, relevanceScore }) => ({
          ...hits[index],
          relevanceScore,
        }));

      return rerankedHits;
    }

    return hits;
  }

  async similarIssues(workspaceId: string, issueId: string) {
    // Prepare the search request for Typesense
    const searchRequests = {
      searches: [
        {
          collection: 'issues',
          q: '*',
          vector_query: `embeddings:([], id: ${issueId},  distance_threshold:0.5)`,
          filter_by: `workspaceId:=${workspaceId}`,
          exclude_fields: 'embeddings',
          page: 1,
        },
      ],
    };

    // Perform the multi-search request to Typesense
    const searchResults =
      await this.typesenseClient.multiSearch.perform(searchRequests);

    // Extract the relevant fields from the search results
    const hits = mapSearchHits(searchResults);

    // If using Cohere and there are search hits, perform reranking
    if (this.isCohere && hits.length > 0) {
      // Retrieve the issue document from Typesense
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issueDoc: any = await this.typesenseClient
        .collections('issues')
        .documents(issueId)
        .retrieve();

      // Construct the query for reranking
      const similarQuery = `${issueDoc.issueNumber}_${issueDoc.title}_${issueDoc.descriptionString}`;

      // Prepare the documents for reranking
      const documents = hits.map(
        ({ issueNumber, title, descriptionString }) => ({
          text: `${issueNumber}_${title}_${descriptionString}`,
        }),
      );

      // Perform reranking using Cohere
      const { results: rerankResults } = await this.cohereClient.rerank({
        documents,
        query: similarQuery,
        topN: hits.length,
        model: this.rerankModel,
      });

      // Filter and map the reranked results based on relevance score
      const relevanceThreshold = 0.9;
      const rerankedHits = rerankResults
        .filter(({ relevanceScore }) => relevanceScore >= relevanceThreshold)
        .map(({ index, relevanceScore }) => ({
          ...hits[index],
          relevanceScore,
        }));

      return rerankedHits;
    }

    return hits;
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

function buildFilterBy(workspaceId: string, stateCategories: string[]): string {
  const filters = [`workspaceId:=${workspaceId}`];

  if (stateCategories.length > 0) {
    filters.push(`stateCategory:=[${stateCategories.join(',')}]`);
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
          }),
        ),
      )
      .flat()
      .filter(Boolean)
  );
}
