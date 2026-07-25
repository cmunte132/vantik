-- Pages: canonical workspace documentation that doubles as a cross-agent memory
-- bank. Two tables, deliberately. `Page` is the human artifact — a tiptap body
-- in a tree, edited like any document. `PageEntry` is one atomic asserted fact
-- appended by an agent, carrying the provenance and status that make it
-- trustworthy enough to serve back to another agent later.

-- The replication decoder keys sync actions off the postgres relation name, so
-- the enum backing SyncAction.modelName has to learn the new tables before any
-- of their rows can be broadcast to clients.
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'Page';
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'PageEntry';
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'PageHistory';

-- Volume control lives in the data layer rather than in tool descriptions: a
-- description asking for restraint is advisory, and fails against exactly the
-- unfamiliar models this feature exists to serve.
CREATE TYPE "PageEntryPolicy" AS ENUM ('OPEN', 'CURATED', 'LOCKED');

-- Retrieval serves STANDING only. Every other value is a reason not to serve:
-- untriaged, already folded into the body, replaced, contradicted, or aged out.
CREATE TYPE "PageEntryStatus" AS ENUM ('PROPOSED', 'STANDING', 'CONSOLIDATED', 'SUPERSEDED', 'DISPUTED', 'ARCHIVED');

-- Sharing is workspace-only for now; the column exists so the shape is settled
-- before anything depends on it.
CREATE TYPE "PageVisibility" AS ENUM ('WORKSPACE');

CREATE TABLE "Page" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "sortOrder" INTEGER,
    "entryPolicy" "PageEntryPolicy" NOT NULL DEFAULT 'CURATED',
    "visibility" "PageVisibility" NOT NULL DEFAULT 'WORKSPACE',
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PageEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "content" TEXT NOT NULL,
    "scope" TEXT,
    "status" "PageEntryStatus" NOT NULL DEFAULT 'PROPOSED',
    "sourceUserId" TEXT,
    "sourceSession" TEXT,
    "sourceTokenId" TEXT,
    "supersedesId" TEXT,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "retrievalCount" INTEGER NOT NULL DEFAULT 0,
    "lastServedAt" TIMESTAMP(3),
    "pageId" TEXT NOT NULL,

    CONSTRAINT "PageEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PageHistory" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "userId" TEXT,
    "pageId" TEXT NOT NULL,
    "changes" JSONB,

    CONSTRAINT "PageHistory_pkey" PRIMARY KEY ("id")
);

-- Every page read is "the pages in this workspace" or "the children of this
-- page"; every entry read is "the entries on this page", often narrowed to a
-- status.
CREATE INDEX "Page_workspaceId_idx" ON "Page"("workspaceId");
CREATE INDEX "Page_parentId_idx" ON "Page"("parentId");
CREATE INDEX "PageEntry_pageId_idx" ON "PageEntry"("pageId");
CREATE INDEX "PageEntry_status_idx" ON "PageEntry"("status");
CREATE INDEX "PageHistory_pageId_idx" ON "PageHistory"("pageId");

-- Two entries claiming to replace the same fact is a contradiction, not a
-- supersede, so the pointer is one-to-one.
CREATE UNIQUE INDEX "PageEntry_supersedesId_key" ON "PageEntry"("supersedesId");

-- Questions the bank could not answer. Postgres rather than a typesense
-- nohits_queries analytics rule, because that aggregates across the entire
-- index with no workspace field, and one workspace's unanswered questions are
-- not another's to read.
CREATE TABLE "PageKnowledgeGap" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "query" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "PageKnowledgeGap_pkey" PRIMARY KEY ("id")
);

-- The unique pair is what lets a repeat question increment a counter instead of
-- adding a row, so the list reads as demand rather than as a query log.
CREATE UNIQUE INDEX "PageKnowledgeGap_workspaceId_query_key" ON "PageKnowledgeGap"("workspaceId", "query");
CREATE INDEX "PageKnowledgeGap_workspaceId_idx" ON "PageKnowledgeGap"("workspaceId");

ALTER TABLE "Page" ADD CONSTRAINT "Page_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Page" ADD CONSTRAINT "Page_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PageEntry" ADD CONSTRAINT "PageEntry_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PageEntry" ADD CONSTRAINT "PageEntry_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "PageEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PageHistory" ADD CONSTRAINT "PageHistory_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
