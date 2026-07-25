-- A native Definition of Done: each issue can carry an ordered list of
-- acceptance criteria that are ticked off independently. Modelled as its own
-- table so every item change replicates as a discrete sync action, the same way
-- comments and relations already do, rather than as opaque edits to a JSON blob
-- on the issue.

-- The replication decoder keys sync actions off the postgres relation name, so
-- the enum backing SyncAction.modelName has to learn the new table before any
-- ChecklistItem row can be broadcast to clients.
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'ChecklistItem';

CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "body" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "issueId" TEXT NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- Every read is "the items for this issue", so index the foreign key.
CREATE INDEX "ChecklistItem_issueId_idx" ON "ChecklistItem"("issueId");

ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
