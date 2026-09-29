-- CreateEnum
CREATE TYPE "KnowledgeVerificationState" AS ENUM ('PENDING', 'FOUND', 'NOTHING', 'FAILED', 'NO_PROVIDER');

-- CreateTable
CREATE TABLE "KnowledgeVerification" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "entryId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "state" "KnowledgeVerificationState" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "model" TEXT,
    "found" INTEGER NOT NULL DEFAULT 0,
    "outside" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "steps" JSONB,
    "replaced" JSONB,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "KnowledgeVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVerification_entryId_key" ON "KnowledgeVerification"("entryId");

-- CreateIndex
CREATE INDEX "KnowledgeVerification_workspaceId_createdAt_idx" ON "KnowledgeVerification"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeVerification_state_createdAt_idx" ON "KnowledgeVerification"("state", "createdAt");

-- AddForeignKey
ALTER TABLE "KnowledgeVerification" ADD CONSTRAINT "KnowledgeVerification_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PageEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
