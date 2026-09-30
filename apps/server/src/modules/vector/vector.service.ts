import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PageEntryKindEnum,
  PageEntryStatusEnum,
  WorkflowCategoryEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import {
  convertTiptapJsonToMarkdown,
  convertTiptapJsonToText,
} from 'common/utils/tiptap.utils';
import { scopeAncestors, scopePath } from 'modules/modules/module-routing';
import {
  entryProof,
  OBSERVED_STALE_MS,
  pageBodyProof,
  ProofCitationRow,
} from 'modules/pages/knowledge-proof';

import { EmbeddingsService } from './embeddings.service';
import {
  AxisFilter,
  entryGroup,
  IssueSearchHit,
  KNOWLEDGE_GROUP_LIMIT,
  KNOWLEDGE_NEAR_MATCH_DISTANCE,
  KnowledgeSearchHit,
  KnowledgeSearchResult,
  RESOLUTION_SNIPPET_LENGTH,
  SERVED_STATUSES,
  SIMILAR_ISSUE_DISTANCE_THRESHOLD,
} from './vector.interface';

type QueryVector = { vector: string; model: string; dimensions: number };

type KnowledgeOptions = {
  limit?: number;
  scope?: string;
  pageId?: string;
  group?: string;
  includeStatuses?: string[];
  vectorDistance?: number;
  kinds?: string[];
  moduleIds?: string[];
  boost?: { modules: string[]; neighbours: string[] };
  ungrouped?: boolean;
  semanticOnly?: boolean;
};

type CitationJson = Omit<ProofCitationRow, 'checkedAt'> & {
  checkedAt: string | null;
};

type KnowledgeRow = Omit<KnowledgeSearchHit, 'distance'> & {
  distance: number | null;
  verifiedAt: string | null;
  proofCitations: CitationJson[];
};

@Injectable()
export class VectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  private async queryVector(text: string): Promise<QueryVector | null> {
    if (!this.embeddings.configuredModel() || text.trim() === '*') {
      return null;
    }
    const result = await this.embeddings.embed(text);
    return result
      ? {
          vector: `[${result.vector.join(',')}]`,
          model: result.model,
          dimensions: result.vector.length,
        }
      : null;
  }

  async searchEmbeddings(
    workspaceId: string,
    searchQuery: string,
    limit: number,
    vectorDistance = 0.8,
    stateCategories: string[] = [],
    axis: AxisFilter = {},
    visibleTeamIds?: string[],
  ): Promise<IssueSearchHit[]> {
    validateId(workspaceId, 'workspaceId');
    validateLimit(limit);
    return this.issueSearch(
      workspaceId,
      searchQuery,
      limit,
      Number.isNaN(vectorDistance) ? 0.8 : vectorDistance,
      stateCategories,
      axis,
      visibleTeamIds,
      await this.queryVector(searchQuery),
    );
  }

  async similarIssues(
    workspaceId: string,
    issueId: string,
    visibleTeamIds?: string[],
  ): Promise<IssueSearchHit[]> {
    validateId(workspaceId, 'workspaceId');
    const visibility = teamVisibility(visibleTeamIds);
    const [source] = await this.prisma.$queryRaw<
      Array<{
        title: string;
        embeddingText: string;
        vector: string | null;
        model: string | null;
        dimensions: number | null;
      }>
    >(Prisma.sql`
      SELECT i."title",
        concat_ws(E'\n\n', COALESCE(d."title", i."title"), d."body", d."comments") AS "embeddingText",
        CASE WHEN d."embeddedHash" = d."contentHash" THEN d."embedding"::text END AS vector,
        d."embeddingModel" AS model, vector_dims(d."embedding") AS dimensions
      FROM "Issue" i JOIN "Team" t ON t."id" = i."teamId"
      LEFT JOIN "SearchDocument" d ON d."id" = 'issue:' || i."id"
      WHERE i."id" = ${issueId} AND t."workspaceId" = ${workspaceId}
        AND i."deleted" IS NULL AND t."deleted" IS NULL AND ${visibility}
    `);
    if (!source) {
      return [];
    }
    const vector =
      source.vector &&
      source.model &&
      source.model === this.embeddings.configuredModel()
        ? {
            vector: source.vector,
            model: source.model,
            dimensions: source.dimensions!,
          }
        : await this.queryVector(source.embeddingText);
    return this.issueSearch(
      workspaceId,
      vector ? '*' : source.title,
      10,
      SIMILAR_ISSUE_DISTANCE_THRESHOLD,
      [],
      {},
      visibleTeamIds,
      vector,
      issueId,
    );
  }

  private async issueSearch(
    workspaceId: string,
    query: string,
    limit: number,
    distance: number,
    categories: string[],
    axis: AxisFilter,
    visibleTeamIds: string[] | undefined,
    vector: QueryVector | null,
    excludeId?: string,
  ): Promise<IssueSearchHit[]> {
    const states = categories.filter((value) =>
      Object.values(WorkflowCategoryEnum).includes(
        value as WorkflowCategoryEnum,
      ),
    );
    const filters = [
      Prisma.sql`d."kind" = 'issue' AND d."workspaceId" = ${workspaceId}`,
      Prisma.sql`t."workspaceId" = ${workspaceId} AND t."deleted" IS NULL AND i."deleted" IS NULL`,
      teamVisibility(visibleTeamIds),
      ...(states.length
        ? [Prisma.sql`w."category"::text IN (${Prisma.join(states)})`]
        : []),
      ...(axis.moduleIds?.length
        ? [Prisma.sql`i."moduleIds" && ${axis.moduleIds}::text[]`]
        : []),
      ...(axis.capabilityId
        ? [Prisma.sql`i."capabilityId" = ${axis.capabilityId}`]
        : []),
      ...(excludeId ? [Prisma.sql`i."id" <> ${excludeId}`] : []),
    ];
    const rows = await this.prisma.$queryRaw<
      Array<
        IssueSearchHit & {
          distance: number | null;
          resolutionBody: string | null;
        }
      >
    >(Prisma.sql`
      WITH documents AS (
        SELECT d.*, i."title" AS "issueTitle", i."description", i."stateId",
          COALESCE(w."category"::text, '') AS "stateCategory", i."teamId", i."number",
          t."identifier" || '-' || i."number" AS "issueNumber", i."assigneeId"
        FROM "SearchDocument" d JOIN "Issue" i ON i."id" = d."sourceId"
        JOIN "Team" t ON t."id" = i."teamId"
        LEFT JOIN "Workflow" w ON w."id" = i."stateId" AND w."deleted" IS NULL
        WHERE ${Prisma.join(filters, ' AND ')}
      ), ${rankDocuments(
        query,
        vector,
        distance,
        Boolean(excludeId && vector),
        Prisma.sql`d."issueNumber" ILIKE ${query.trim().replace(/[\\%_]/g, '\\$&') + '%'}
          OR d."number"::text ILIKE ${query.trim().replace(/[\\%_]/g, '\\$&') + '%'}`,
      )},
      chosen AS (
        SELECT d.*, r.score, r.distance FROM documents d JOIN ranked r USING ("id")
        ORDER BY r.score DESC, r.distance ASC NULLS LAST, d."id" LIMIT ${limit}
      )
      SELECT c."sourceId" AS id, c."issueTitle" AS title, COALESCE(c."description", '') AS description,
        c."body" AS "descriptionString", c."stateId", c."stateCategory", c."teamId", c."number",
        c."issueNumber", c."workspaceId", COALESCE(c."assigneeId", '') AS "assigneeId", c.distance,
        resolution."body" AS "resolutionBody"
      FROM chosen c
      LEFT JOIN LATERAL (
        SELECT MAX(h."updatedAt") AS "completedAt"
        FROM "IssueHistory" h JOIN "Workflow" state ON state."id" = h."toStateId"
        WHERE h."issueId" = c."sourceId" AND h."deleted" IS NULL
          AND state."category" = 'COMPLETED' AND state."deleted" IS NULL
      ) completion ON TRUE
      LEFT JOIN LATERAL (
        SELECT comment."body" FROM "IssueComment" comment
        WHERE comment."issueId" = c."sourceId" AND comment."deleted" IS NULL AND comment."parentId" IS NULL
          AND (comment."createdAt" <= completion."completedAt" OR c."stateCategory" = 'COMPLETED')
        ORDER BY CASE WHEN comment."createdAt" <= completion."completedAt" THEN 0 ELSE 1 END,
          comment."createdAt" DESC, comment."id"
        LIMIT 1
      ) resolution ON TRUE
      ORDER BY c.score DESC, c.distance ASC NULLS LAST, c."id"
    `);
    return rows.map(({ resolutionBody, distance: value, ...row }) => ({
      ...row,
      descriptionMarkdown: convertTiptapJsonToMarkdown(row.description),
      resolutionSnippet: convertTiptapJsonToText(resolutionBody).slice(
        0,
        RESOLUTION_SNIPPET_LENGTH,
      ),
      ...distanceFields(value),
    }));
  }

  async searchKnowledge(
    workspaceId: string,
    query: string,
    options: KnowledgeOptions = {},
  ): Promise<KnowledgeSearchResult> {
    validateId(workspaceId, 'workspaceId');
    if (options.pageId) {
      validateId(options.pageId, 'pageId');
    }
    const limit = options.limit ?? 20;
    validateLimit(limit);
    const vector = await this.queryVector(query);
    const statuses = (
      options.includeStatuses?.length
        ? options.includeStatuses
        : SERVED_STATUSES
    ).filter((value) =>
      Object.values(PageEntryStatusEnum).includes(value as PageEntryStatusEnum),
    );
    const kinds = (options.kinds ?? []).filter((value) =>
      Object.values(PageEntryKindEnum).includes(value as PageEntryKindEnum),
    );
    const filters = [
      Prisma.sql`d."workspaceId" = ${workspaceId} AND d."kind" IN ('page', 'entry')`,
      Prisma.sql`((d."kind" = 'page' AND p."workspaceId" = ${workspaceId} AND p."deleted" IS NULL)
        OR (d."kind" = 'entry' AND e."workspaceId" = ${workspaceId} AND e."deleted" IS NULL
          AND (e."pageId" IS NULL OR (p."deleted" IS NULL AND p."workspaceId" = ${workspaceId}))))`,
      statuses.length
        ? Prisma.sql`CASE WHEN d."kind" = 'page' THEN 'STANDING' ELSE e."status"::text END IN (${Prisma.join(statuses)})`
        : Prisma.sql`FALSE`,
      ...(options.pageId ? [Prisma.sql`p."id" = ${options.pageId}`] : []),
      ...(options.group
        ? [
            Prisma.sql`COALESCE(p."id", 'scope:' || COALESCE(e."scope", '')) = ${options.group}`,
          ]
        : []),
      ...(kinds.length
        ? [Prisma.sql`e."kind"::text IN (${Prisma.join(kinds)})`]
        : []),
      ...(options.moduleIds?.length
        ? [Prisma.sql`e."moduleIds" && ${options.moduleIds}::text[]`]
        : []),
    ];
    if (options.scope) {
      const path = scopePath(options.scope);
      filters.push(
        path
          ? Prisma.sql`(COALESCE(e."scope", '') = '' OR search_scope_path(e."scope") IN (${Prisma.join(scopeAncestors(options.scope))})
            OR starts_with(search_scope_path(e."scope"), ${path + '/'}))`
          : Prisma.sql`(COALESCE(e."scope", '') = '' OR e."scope" = ${options.scope})`,
      );
    }
    const moduleBoost = options.boost?.modules.length
      ? Prisma.sql`CASE WHEN e."moduleIds" && ${options.boost.modules}::text[] THEN 2
          ${options.boost.neighbours.length ? Prisma.sql`WHEN e."moduleIds" && ${options.boost.neighbours}::text[] THEN 1` : Prisma.empty}
          ELSE 0 END`
      : options.boost?.neighbours.length
        ? Prisma.sql`CASE WHEN e."moduleIds" && ${options.boost.neighbours}::text[] THEN 1 ELSE 0 END`
        : Prisma.sql`0`;
    const scopeBoost = options.scope
      ? Prisma.sql`CASE WHEN COALESCE(e."scope", '') <> '' THEN 1 ELSE 0 END`
      : Prisma.sql`0`;
    const [result] = await this.prisma.$queryRaw<
      Array<{
        hits: KnowledgeRow[];
        facets: Record<string, Record<string, number>>;
        found: number;
      }>
    >(Prisma.sql`
      WITH documents AS (
        SELECT d.*, p."id" AS "pageId", COALESCE(p."title", '') AS "pageTitle",
          e."id" AS "entryId", e."scope", COALESCE(e."status"::text, 'STANDING') AS status,
          e."sourceUserId", e."verifiedAt", COALESCE(e."retrievalCount", 0) AS "retrievalCount",
          e."kind"::text AS "entryKind", COALESCE(e."moduleIds", ARRAY[]::text[]) AS "moduleIds",
          COALESCE(p."id", 'scope:' || COALESCE(e."scope", '')) AS "groupKey",
          ${scopeBoost} AS "scopeBoost", ${moduleBoost} AS "moduleBoost",
          CASE WHEN d."kind" = 'page' OR e."verifiedAt" IS NOT NULL THEN 2
            WHEN e."status" IN ('STANDING', 'CONSOLIDATED') AND EXISTS (
              SELECT 1 FROM "PageEntryCitation" citation WHERE citation."entryId" = e."id"
            ) AND NOT EXISTS (
              SELECT 1 FROM "PageEntryCitation" citation WHERE citation."entryId" = e."id"
                AND (COALESCE(citation."checkResult"::text, '') NOT IN ('HOLDS', 'MOVED')
                  OR (citation."kind" = 'URL' AND (citation."checkedAt" IS NULL
                    OR citation."checkedAt" < ${new Date(Date.now() - OBSERVED_STALE_MS)})))
            ) THEN 1 ELSE 0 END AS "trustBoost"
        FROM "SearchDocument" d
        LEFT JOIN "PageEntry" e ON d."kind" = 'entry' AND e."id" = d."sourceId"
        LEFT JOIN "Page" p ON p."id" = CASE WHEN d."kind" = 'page' THEN d."sourceId" ELSE e."pageId" END
        WHERE ${Prisma.join(filters, ' AND ')}
      ), ${rankDocuments(
        query,
        vector,
        options.vectorDistance ?? 0.8,
        options.semanticOnly,
        Prisma.sql`d."scope" ILIKE ${query.trim().replace(/[\\%_]/g, '\\$&') + '%'}`,
      )},
      matches AS (
        SELECT d.*, r.score, r.distance,
          row_number() OVER (ORDER BY ${knowledgeOrder(options)}, d."id") AS position
        FROM documents d JOIN ranked r USING ("id")
      ), evidence AS (
        SELECT m.*, citing."pageId" AS "evidencePageId", citing."pageTitle" AS "evidencePageTitle",
          citing.position AS "evidencePosition"
        FROM matches m LEFT JOIN LATERAL (
          SELECT page."id" AS "pageId", page."title" AS "pageTitle", body.position
          FROM "Page" page LEFT JOIN matches body ON body."kind" = 'page' AND body."pageId" = page."id"
          WHERE m."kind" = 'entry' AND page."workspaceId" = ${workspaceId} AND page."deleted" IS NULL
            AND (m."entryId" = ANY(page."citedEntryIds")
              OR (m.status = 'CONSOLIDATED' AND m."pageId" = page."id"))
          ORDER BY body.position ASC NULLS LAST, page."id" LIMIT 1
        ) citing ON TRUE
      ), ordered AS (
        SELECT *, GREATEST(position, COALESCE("evidencePosition", position)) AS "servePosition",
          row_number() OVER (PARTITION BY "groupKey" ORDER BY
            GREATEST(position, COALESCE("evidencePosition", position)),
            CASE WHEN "kind" = 'page' THEN 0 ELSE 1 END, position) AS "groupPosition"
        FROM evidence
      ), selected AS (
        SELECT * FROM ordered
        ${options.ungrouped ? Prisma.empty : Prisma.sql`WHERE "groupPosition" <= ${KNOWLEDGE_GROUP_LIMIT}`}
        ORDER BY "servePosition", CASE WHEN "kind" = 'page' THEN 0 ELSE 1 END, position LIMIT ${limit}
      ), hit_rows AS (
        SELECT s."id", s."kind", s."pageId", s."pageTitle", s."entryId", s."title",
          s."body" AS content, s."scope", s.status, s."sourceUserId",
          (s."kind" = 'page' OR s."verifiedAt" IS NOT NULL) AS verified,
          s."verifiedAt", s."retrievalCount", s."entryKind", s."moduleIds", s.distance,
          CASE WHEN s."evidencePageId" IS NOT NULL THEN jsonb_build_object(
            'pageId', s."evidencePageId", 'pageTitle', s."evidencePageTitle") END AS "evidenceFor",
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'kind', c."kind", 'path', c."path", 'commitSha', c."commitSha", 'startLine', c."startLine",
            'endLine', c."endLine", 'targetLabel', c."targetLabel", 'checkedAt', c."checkedAt",
            'checkedSha', c."checkedSha", 'checkResult', c."checkResult", 'judgment', c."judgment",
            'judgeModel', c."judgeModel", 'moduleRepo', CASE WHEN repo."id" IS NOT NULL
              THEN jsonb_build_object('fullName', repo."fullName") END) ORDER BY c."createdAt", c."id")
            FROM "PageEntryCitation" c LEFT JOIN "ModuleRepo" repo ON repo."id" = c."moduleRepoId"
            WHERE c."entryId" = s."entryId"), '[]'::jsonb) AS "proofCitations",
          s."servePosition", s.position
        FROM selected s
      ), facet_counts AS (
        SELECT field, value, COUNT(*)::int AS count FROM matches m
        CROSS JOIN LATERAL (VALUES ('sourceUserId', COALESCE(m."sourceUserId", '')),
          ('scope', COALESCE(m."scope", '')), ('status', m.status), ('kind', m."kind"),
          ('entryKind', COALESCE(m."entryKind", ''))) facet(field, value)
        GROUP BY field, value
      ), facets AS (
        SELECT field, jsonb_object_agg(value, count) AS counts FROM facet_counts GROUP BY field
      )
      SELECT COALESCE((SELECT jsonb_agg(to_jsonb(hit_rows) - 'servePosition' - 'position'
        ORDER BY "servePosition", CASE WHEN "kind" = 'page' THEN 0 ELSE 1 END, position)
        FROM hit_rows), '[]'::jsonb) AS hits,
        COALESCE((SELECT jsonb_object_agg(field, counts) FROM facets), '{}'::jsonb) AS facets,
        (SELECT ${options.ungrouped ? Prisma.sql`COUNT(*)` : Prisma.sql`COUNT(DISTINCT "groupKey")`}::int FROM matches) AS found
    `);
    return {
      facets: result.facets,
      found: result.found,
      hits: result.hits.map(
        ({ proofCitations, verifiedAt, distance, ...hit }) => ({
          ...hit,
          ...(hit.entryId
            ? entryProof({
                status: hit.status,
                verifiedAt: verifiedAt ? new Date(verifiedAt) : null,
                citations: proofCitations.map((citation) => ({
                  ...citation,
                  checkedAt: citation.checkedAt
                    ? new Date(citation.checkedAt)
                    : null,
                })),
              })
            : pageBodyProof()),
          ...distanceFields(distance),
        }),
      ),
    };
  }

  async findSimilarEntries(
    workspaceId: string,
    pageId: string | null,
    content: string,
  ): Promise<KnowledgeSearchHit[]> {
    const { hits } = await this.searchKnowledge(workspaceId, content, {
      limit: 5,
      vectorDistance: KNOWLEDGE_NEAR_MATCH_DISTANCE,
      ...(pageId ? { pageId } : {}),
      kinds: Object.values(PageEntryKindEnum),
      includeStatuses: [...SERVED_STATUSES, PageEntryStatusEnum.PROPOSED],
    });
    return hits;
  }

  async findNearEntries(
    workspaceId: string,
    content: string,
    options: {
      moduleIds?: string[];
      pageId?: string | null;
      scope?: string | null;
      minSimilarity: number;
      limit?: number;
    },
  ): Promise<Array<{ entryId: string; similarity: number }>> {
    const { hits } = await this.searchKnowledge(workspaceId, content, {
      limit: options.limit ?? 10,
      vectorDistance: 1 - options.minSimilarity,
      semanticOnly: true,
      ...(options.moduleIds?.length
        ? { moduleIds: options.moduleIds }
        : options.pageId
          ? { pageId: options.pageId }
          : {
              group: entryGroup({ pageId: null, scope: options.scope ?? null }),
            }),
      kinds: Object.values(PageEntryKindEnum),
      includeStatuses: [...SERVED_STATUSES, PageEntryStatusEnum.PROPOSED],
    });
    return hits
      .filter(
        (hit) =>
          hit.entryId &&
          typeof hit.distance === 'number' &&
          1 - hit.distance >= options.minSimilarity,
      )
      .map((hit) => ({ entryId: hit.entryId!, similarity: 1 - hit.distance! }));
  }
}

function rankDocuments(
  query: string,
  vector: QueryVector | null,
  threshold: number,
  vectorOnly = false,
  identifierMatch: Prisma.Sql = Prisma.sql`FALSE`,
): Prisma.Sql {
  const wildcard = query.trim() === '*' || query.trim() === '';
  const distance =
    vector?.dimensions === 384
      ? Prisma.sql`d."embedding"::vector(384) <=> ${vector.vector}::vector(384)`
      : vector
        ? Prisma.sql`d."embedding" <=> ${vector.vector}::vector`
        : Prisma.sql`NULL::double precision`;
  const matchingVector = vector
    ? Prisma.sql`d."embeddingModel" = ${vector.model} AND d."embeddedHash" = d."contentHash"
        AND vector_dims(d."embedding") = ${vector.dimensions}`
    : Prisma.sql`FALSE`;
  const ann =
    vector?.dimensions === 384
      ? Prisma.sql`
        SELECT d."id", ${distance} AS distance FROM "SearchDocument" d
        WHERE ${matchingVector}
          AND EXISTS (SELECT 1 FROM documents eligible WHERE eligible."id" = d."id")
        ORDER BY ${distance}
        LIMIT (SELECT COUNT(*) FROM documents)`
      : Prisma.sql`SELECT "id", NULL::double precision AS distance FROM documents WHERE FALSE`;
  const prefix = query.trim().replace(/[\\%_]/g, '\\$&') + '%';
  const prefixQuery = (query.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((word) => `${word}:*`)
    .join(' & ');
  return Prisma.sql`
    vector_ann AS MATERIALIZED (${ann}),
    vector_candidates AS (
      SELECT * FROM vector_ann
      UNION ALL
      SELECT d."id", ${distance} AS distance FROM documents d
      WHERE ${matchingVector}
        AND NOT EXISTS (SELECT 1 FROM vector_ann seen WHERE seen."id" = d."id")
    ),
    lexical AS (
      SELECT d."id", row_number() OVER (ORDER BY
        (ts_rank_cd(d."search", websearch_to_tsquery('english', ${query}))
          + ts_rank_cd(d."search", to_tsquery('english', ${prefixQuery}))
          + word_similarity(${query}, d."title") * 0.1
          + word_similarity(${query}, d."body") * 0.04
          + word_similarity(${query}, d."comments") * 0.02
          + CASE WHEN ${identifierMatch} THEN 1 ELSE 0 END) DESC, d."id") AS rank
      FROM documents d WHERE ${
        wildcard || vectorOnly
          ? Prisma.sql`FALSE`
          : Prisma.sql`
        (d."search" @@ websearch_to_tsquery('english', ${query})
          OR d."search" @@ to_tsquery('english', ${prefixQuery})
          OR d."title" % ${query} OR d."title" ILIKE ${prefix}
          OR word_similarity(${query}, d."title") >= 0.5
          OR word_similarity(${query}, d."body") >= 0.5
          OR word_similarity(${query}, d."comments") >= 0.5
          OR (${identifierMatch}))`
      }
    ), semantic AS (
      SELECT "id", row_number() OVER (ORDER BY distance, "id") AS rank
      FROM vector_candidates WHERE distance <= ${threshold}
    ), ranked AS (
      SELECT d."id", c.distance,
        COALESCE(1.0 / (60 + l.rank), 0) + COALESCE(1.0 / (60 + v.rank), 0) AS score
      FROM documents d LEFT JOIN lexical l USING ("id") LEFT JOIN semantic v USING ("id")
        LEFT JOIN vector_candidates c USING ("id")
      WHERE l.rank IS NOT NULL OR v.rank IS NOT NULL
        ${wildcard && !vectorOnly ? Prisma.sql`OR TRUE` : Prisma.empty}
    )
  `;
}

function knowledgeOrder(options: KnowledgeOptions): Prisma.Sql {
  if (options.scope) {
    return Prisma.sql`d."scopeBoost" DESC, d."moduleBoost" DESC, d."trustBoost" DESC,
      r.score DESC, d."retrievalCount" DESC`;
  }
  if (options.boost?.modules.length || options.boost?.neighbours.length) {
    return Prisma.sql`floor(r.score * 300) DESC, d."moduleBoost" DESC, d."trustBoost" DESC,
      r.score DESC, d."retrievalCount" DESC`;
  }
  return Prisma.sql`r.score DESC, d."trustBoost" DESC,
    CASE WHEN COALESCE(d."scope", '') <> '' THEN 1 ELSE 0 END DESC, d."retrievalCount" DESC`;
}

function teamVisibility(ids?: string[]): Prisma.Sql {
  return ids === undefined
    ? Prisma.sql`TRUE`
    : ids.length
      ? Prisma.sql`t."id" IN (${Prisma.join(ids)})`
      : Prisma.sql`FALSE`;
}

function distanceFields(distance: number | null): {
  distance?: number;
  relevanceScore?: number;
} {
  return distance === null || distance === undefined
    ? {}
    : { distance, relevanceScore: 1 - distance };
}

function validateId(value: string, name: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`Invalid ${name} format`);
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('Search limit must be a non-negative integer');
  }
}
