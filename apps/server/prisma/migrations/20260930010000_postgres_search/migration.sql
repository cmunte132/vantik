BEGIN;

DO $$
DECLARE
    extension_name text;
    extension_schema text;
BEGIN
    FOREACH extension_name IN ARRAY ARRAY['pg_trgm', 'vector'] LOOP
        SELECT n.nspname INTO extension_schema
        FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = extension_name;

        IF FOUND AND extension_schema <> current_schema() THEN
            RAISE EXCEPTION 'Extension % is in schema %, but search requires schema %. Move the extension with ALTER EXTENSION % SET SCHEMA % before this migration.',
                extension_name, extension_schema, current_schema(), extension_name, current_schema();
        END IF;

        EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I', extension_name, current_schema());
    END LOOP;
END;
$$;

CREATE TABLE "SearchDocument" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('issue', 'page', 'entry')),
    "sourceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "comments" TEXT NOT NULL DEFAULT '',
    "search" TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('pg_catalog.english'::regconfig, "title"), 'A') ||
        setweight(to_tsvector('pg_catalog.english'::regconfig, "body"), 'B') ||
        setweight(to_tsvector('pg_catalog.english'::regconfig, "comments"), 'C')
    ) STORED,
    "embedding" VECTOR,
    "embeddingModel" TEXT,
    "contentHash" TEXT NOT NULL DEFAULT '',
    "embeddedHash" TEXT,
    CONSTRAINT "SearchDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SearchDocument_source_check" CHECK ("id" = "kind" || ':' || "sourceId")
);

CREATE INDEX "SearchDocument_workspaceId_kind_idx" ON "SearchDocument" ("workspaceId", "kind");
CREATE INDEX "SearchDocument_search_idx" ON "SearchDocument" USING GIN ("search");
CREATE INDEX "SearchDocument_title_trgm_idx" ON "SearchDocument" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "SearchDocument_body_trgm_idx" ON "SearchDocument" USING GIN ("body" gin_trgm_ops);
CREATE INDEX "SearchDocument_comments_trgm_idx" ON "SearchDocument" USING GIN ("comments" gin_trgm_ops);
CREATE INDEX "SearchDocument_embedding_384_idx" ON "SearchDocument"
    USING HNSW (("embedding"::vector(384)) vector_cosine_ops)
    WHERE "embedding" IS NOT NULL AND vector_dims("embedding") = 384;

CREATE FUNCTION search_json_text(node jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT
AS $$
DECLARE
    result text := '';
    child jsonb;
    node_type text;
BEGIN
    IF node IS NULL THEN
        RETURN '';
    END IF;
    IF jsonb_typeof(node) = 'array' THEN
        FOR child IN SELECT value FROM jsonb_array_elements(node) LOOP
            result := result || search_json_text(child);
        END LOOP;
        RETURN result;
    END IF;
    IF jsonb_typeof(node) <> 'object' THEN
        RETURN '';
    END IF;
    IF jsonb_typeof(node->'descriptionString') = 'string' THEN
        RETURN node->>'descriptionString';
    END IF;
    IF jsonb_typeof(node->'text') = 'string' THEN
        RETURN node->>'text';
    END IF;
    node_type := node->>'type';
    IF node_type IN ('hardBreak', 'horizontalRule') THEN
        RETURN E'\n';
    END IF;
    IF node_type = 'mention' THEN
        RETURN COALESCE(node->'attrs'->>'label', node->'attrs'->>'id', '');
    END IF;
    IF jsonb_typeof(node->'content') = 'array' THEN
        result := search_json_text(node->'content');
    END IF;
    IF node_type IN ('paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem',
                     'bulletList', 'orderedList', 'taskList', 'taskItem', 'tableRow', 'table') THEN
        result := result || E'\n';
    END IF;
    RETURN result;
END;
$$;

CREATE FUNCTION search_text(source text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT
AS $$
DECLARE
    node jsonb;
BEGIN
    IF source IS NULL OR source = '' THEN
        RETURN '';
    END IF;
    BEGIN
        node := source::jsonb;
    EXCEPTION WHEN data_exception THEN
        RETURN source;
    END;
    IF jsonb_typeof(node) = 'object' AND
       (node->>'type' = 'doc' OR node ? 'content' OR node ? 'descriptionString') THEN
        RETURN btrim(search_json_text(node), E' \t\r\n');
    END IF;
    IF jsonb_typeof(node) = 'array' THEN
        RETURN btrim(search_json_text(node), E' \t\r\n');
    END IF;
    IF jsonb_typeof(node) = 'string' THEN
        RETURN node #>> '{}';
    END IF;
    RETURN source;
END;
$$;

CREATE FUNCTION search_scope_path(scope text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
    segment text;
    segments text[] := ARRAY[]::text[];
BEGIN
    IF scope IS NULL OR btrim(scope) = '' THEN
        RETURN NULL;
    END IF;
    FOREACH segment IN ARRAY string_to_array(regexp_replace(btrim(scope), '^\./', ''), '/') LOOP
        IF segment = '' THEN
            CONTINUE;
        END IF;
        IF segment ~ '[*?\[\]{}]' THEN
            EXIT;
        END IF;
        segments := array_append(segments, segment);
    END LOOP;
    RETURN NULLIF(array_to_string(segments, '/'), '');
END;
$$;

CREATE FUNCTION search_document_hash() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW."contentHash" := md5(jsonb_build_array(NEW."title", NEW."body", NEW."comments")::text);
    IF TG_OP = 'INSERT' OR
       ROW(OLD."title", OLD."body", OLD."comments") IS DISTINCT FROM
       ROW(NEW."title", NEW."body", NEW."comments") THEN
        NEW."embedding" := NULL;
        NEW."embeddingModel" := NULL;
        NEW."embeddedHash" := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SearchDocument_hash"
BEFORE INSERT OR UPDATE ON "SearchDocument"
FOR EACH ROW EXECUTE FUNCTION search_document_hash();

CREATE FUNCTION search_refresh_document(document_kind text, source_id text) RETURNS void
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
    document record;
    document_id text := document_kind || ':' || source_id;
BEGIN
    -- This lock lets each text read see the previous transaction's source changes.
    PERFORM pg_advisory_xact_lock(hashtextextended('SearchDocument:' || document_id, 0));
    IF document_kind = 'issue' THEN
        SELECT i."id", t."workspaceId", i."title", search_text(i."description") AS body,
               COALESCE((
                   SELECT string_agg(search_text(c."body"), E'\n' ORDER BY c."createdAt", c."id")
                   FROM "IssueComment" c
                   WHERE c."issueId" = i."id" AND c."deleted" IS NULL
               ), '') AS comments
        INTO document
        FROM "Issue" i
        JOIN "Team" t ON t."id" = i."teamId" AND t."deleted" IS NULL
        JOIN "Workspace" w ON w."id" = t."workspaceId" AND w."deleted" IS NULL
        WHERE i."id" = source_id AND i."deleted" IS NULL;
    ELSIF document_kind = 'page' THEN
        SELECT p."id", p."workspaceId", p."title", search_text(p."description") AS body, ''::text AS comments
        INTO document
        FROM "Page" p
        JOIN "Workspace" w ON w."id" = p."workspaceId" AND w."deleted" IS NULL
        WHERE p."id" = source_id AND p."deleted" IS NULL;
    ELSIF document_kind = 'entry' THEN
        SELECT e."id", e."workspaceId", COALESCE(p."title", '') AS title, e."content" AS body, ''::text AS comments
        INTO document
        FROM "PageEntry" e
        JOIN "Workspace" w ON w."id" = e."workspaceId" AND w."deleted" IS NULL
        LEFT JOIN "Page" p ON p."id" = e."pageId"
        WHERE e."id" = source_id AND e."deleted" IS NULL
          AND (e."pageId" IS NULL OR (p."id" IS NOT NULL AND p."deleted" IS NULL AND p."workspaceId" = e."workspaceId"));
    ELSE
        RAISE EXCEPTION 'Unknown search document kind: %', document_kind;
    END IF;

    IF NOT FOUND THEN
        DELETE FROM "SearchDocument" WHERE "id" = document_id;
        RETURN;
    END IF;

    INSERT INTO "SearchDocument" ("id", "kind", "sourceId", "workspaceId", "title", "body", "comments")
    VALUES (document_id, document_kind, source_id, document."workspaceId", document."title", document.body, document.comments)
    ON CONFLICT ("id") DO UPDATE
    SET "workspaceId" = EXCLUDED."workspaceId", "title" = EXCLUDED."title",
        "body" = EXCLUDED."body", "comments" = EXCLUDED."comments"
    WHERE ROW("SearchDocument"."workspaceId", "SearchDocument"."title", "SearchDocument"."body", "SearchDocument"."comments")
       IS DISTINCT FROM ROW(EXCLUDED."workspaceId", EXCLUDED."title", EXCLUDED."body", EXCLUDED."comments");
END;
$$;

CREATE FUNCTION search_source_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
    document_kind text;
    source_id text;
    entry_id text;
BEGIN
    document_kind := CASE TG_TABLE_NAME WHEN 'Issue' THEN 'issue' WHEN 'Page' THEN 'page' ELSE 'entry' END;
    IF TG_OP = 'DELETE' THEN
        source_id := OLD."id";
    ELSE
        source_id := NEW."id";
    END IF;
    IF TG_OP = 'UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
        PERFORM search_refresh_document(document_kind, OLD."id");
    END IF;
    PERFORM search_refresh_document(document_kind, source_id);
    IF TG_TABLE_NAME = 'Page' THEN
        FOR entry_id IN
            SELECT "id" FROM "PageEntry" WHERE "pageId" = source_id ORDER BY "id"
        LOOP
            PERFORM search_refresh_document('entry', entry_id);
        END LOOP;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "Issue_search_insert_delete"
AFTER INSERT OR DELETE ON "Issue" FOR EACH ROW EXECUTE FUNCTION search_source_change();
CREATE TRIGGER "Issue_search_update"
AFTER UPDATE OF "id", "title", "description", "teamId", "deleted" ON "Issue"
FOR EACH ROW EXECUTE FUNCTION search_source_change();
CREATE TRIGGER "Page_search_insert_delete"
AFTER INSERT OR DELETE ON "Page" FOR EACH ROW EXECUTE FUNCTION search_source_change();
CREATE TRIGGER "Page_search_update"
AFTER UPDATE OF "id", "title", "description", "workspaceId", "deleted" ON "Page"
FOR EACH ROW EXECUTE FUNCTION search_source_change();
CREATE TRIGGER "PageEntry_search_insert_delete"
AFTER INSERT OR DELETE ON "PageEntry" FOR EACH ROW EXECUTE FUNCTION search_source_change();
CREATE TRIGGER "PageEntry_search_update"
AFTER UPDATE OF "id", "content", "pageId", "workspaceId", "deleted" ON "PageEntry"
FOR EACH ROW EXECUTE FUNCTION search_source_change();

CREATE FUNCTION search_comment_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
        PERFORM search_refresh_document('issue', OLD."issueId");
    END IF;
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW."issueId" IS DISTINCT FROM OLD."issueId") THEN
        PERFORM search_refresh_document('issue', NEW."issueId");
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "IssueComment_search_insert_delete"
AFTER INSERT OR DELETE ON "IssueComment" FOR EACH ROW EXECUTE FUNCTION search_comment_change();
CREATE TRIGGER "IssueComment_search_update"
AFTER UPDATE OF "body", "deleted", "issueId", "createdAt", "id" ON "IssueComment"
FOR EACH ROW EXECUTE FUNCTION search_comment_change();

CREATE FUNCTION search_team_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
    issue_id text;
BEGIN
    FOR issue_id IN
        SELECT "id" FROM "Issue" WHERE "teamId" = OLD."id" OR "teamId" = NEW."id" ORDER BY "id"
    LOOP
        PERFORM search_refresh_document('issue', issue_id);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "Team_search_change"
AFTER UPDATE OF "id", "identifier", "workspaceId", "deleted" OR DELETE ON "Team"
FOR EACH ROW EXECUTE FUNCTION search_team_change();

CREATE FUNCTION search_workspace_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
    source record;
BEGIN
    FOR source IN
        SELECT 'issue'::text AS kind, i."id" FROM "Issue" i JOIN "Team" t ON t."id" = i."teamId"
        WHERE t."workspaceId" = OLD."id" OR t."workspaceId" = NEW."id"
        UNION ALL
        SELECT 'page', "id" FROM "Page" WHERE "workspaceId" = OLD."id" OR "workspaceId" = NEW."id"
        UNION ALL
        SELECT 'entry', "id" FROM "PageEntry" WHERE "workspaceId" = OLD."id" OR "workspaceId" = NEW."id"
        ORDER BY kind, "id"
    LOOP
        PERFORM search_refresh_document(source.kind, source."id");
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "Workspace_search_change"
AFTER UPDATE OF "id", "deleted" OR DELETE ON "Workspace"
FOR EACH ROW EXECUTE FUNCTION search_workspace_change();

-- The worker creates vectors after the migration. SQL does not call an external service.
DO $$
DECLARE
    source record;
BEGIN
    FOR source IN
        SELECT 'issue'::text AS kind, "id" FROM "Issue"
        UNION ALL SELECT 'page', "id" FROM "Page"
        UNION ALL SELECT 'entry', "id" FROM "PageEntry"
        ORDER BY kind, "id"
    LOOP
        PERFORM search_refresh_document(source.kind, source."id");
    END LOOP;
END;
$$;

COMMIT;
