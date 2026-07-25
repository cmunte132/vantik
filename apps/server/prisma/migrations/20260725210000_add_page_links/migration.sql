-- Edges between a page and the rest of the workspace, so documentation can be
-- reached from the work it describes rather than only by search.
CREATE TYPE "PageLinkType" AS ENUM ('TEAM', 'PROJECT', 'ISSUE', 'PAGE');

CREATE TABLE "PageLink" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "pageId" TEXT NOT NULL,
    "entityType" "PageLinkType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "PageLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PageLink_pageId_entityType_entityId_key" ON "PageLink"("pageId", "entityType", "entityId");
CREATE INDEX "PageLink_pageId_idx" ON "PageLink"("pageId");
-- The reverse lookup: "what pages relate to this issue/project/team".
CREATE INDEX "PageLink_entityType_entityId_idx" ON "PageLink"("entityType", "entityId");

ALTER TABLE "PageLink" ADD CONSTRAINT "PageLink_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
