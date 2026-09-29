-- CreateEnum
CREATE TYPE "KnowledgeInboxKind" AS ENUM ('CONTRADICTION', 'RULE', 'FACT', 'AUDIT', 'ARCHIVE', 'REWRITE', 'GAP');

-- CreateEnum
CREATE TYPE "KnowledgeInboxEventType" AS ENUM ('ASSIGNED', 'COMMENTED', 'DECIDED', 'SETTLED');

-- CreateTable
CREATE TABLE "KnowledgeInboxItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "KnowledgeInboxKind" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "entryId" TEXT,
    "raisedAt" TIMESTAMP(3) NOT NULL,
    "assigneeId" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "resolution" TEXT,

    CONSTRAINT "KnowledgeInboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeInboxEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" TEXT NOT NULL,
    "type" "KnowledgeInboxEventType" NOT NULL,
    "userId" TEXT,
    "assigneeId" TEXT,
    "body" TEXT,

    CONSTRAINT "KnowledgeInboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeInboxItem_workspaceId_doneAt_idx" ON "KnowledgeInboxItem"("workspaceId", "doneAt");

-- CreateIndex
CREATE INDEX "KnowledgeInboxItem_entryId_idx" ON "KnowledgeInboxItem"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeInboxItem_workspaceId_kind_subjectId_key" ON "KnowledgeInboxItem"("workspaceId", "kind", "subjectId");

-- CreateIndex
CREATE INDEX "KnowledgeInboxEvent_itemId_createdAt_idx" ON "KnowledgeInboxEvent"("itemId", "createdAt");

-- AddForeignKey
ALTER TABLE "KnowledgeInboxItem" ADD CONSTRAINT "KnowledgeInboxItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeInboxItem" ADD CONSTRAINT "KnowledgeInboxItem_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PageEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeInboxEvent" ADD CONSTRAINT "KnowledgeInboxEvent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "KnowledgeInboxItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

