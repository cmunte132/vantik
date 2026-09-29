-- A fact can live on no page. It then carries its own workspace, which every
-- existing entry takes from its page.
ALTER TABLE "PageEntry" ADD COLUMN "workspaceId" TEXT;

UPDATE "PageEntry" AS e
SET "workspaceId" = p."workspaceId"
FROM "Page" AS p
WHERE p."id" = e."pageId";

ALTER TABLE "PageEntry" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "PageEntry" ALTER COLUMN "pageId" DROP NOT NULL;

ALTER TABLE "PageEntry" ADD CONSTRAINT "PageEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PageEntry_workspaceId_pageId_idx" ON "PageEntry"("workspaceId", "pageId");

-- The trail of a fact's moves between pages.
CREATE TABLE "PageEntryMove" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "fromPageId" TEXT,
    "toPageId" TEXT,
    "movedById" TEXT,
    "suggested" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PageEntryMove_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PageEntryMove_entryId_createdAt_idx" ON "PageEntryMove"("entryId", "createdAt");

ALTER TABLE "PageEntryMove" ADD CONSTRAINT "PageEntryMove_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PageEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
