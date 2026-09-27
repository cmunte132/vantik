-- Knowledge uses and outcomes: what each reader was served, and what came of
-- the runs that were served it.
--
-- PageEntryUse records every entry served, with how (a run's context pack, a
-- recall, a load_context), the run it was packed for, and the session, token
-- and user that asked. PageEntrySignal records each helpful or harmful signal
-- a run's end or its pull request gave an entry, one row per entry, run and
-- source; the entry keeps weighted totals of them. A run records whether it
-- was handed knowledge or held out from it, and what became of its pull
-- request, so the two arms can be compared. An iteration records the
-- reviewer's verdict and the paths its failing checks named.
--
-- New tables, new enums and new nullable or defaulted columns; no existing
-- row changes meaning. Runs from before this migration have no arm and are
-- left out of the comparison.
-- CreateEnum
CREATE TYPE "PageEntryUseVia" AS ENUM ('CONTEXT_PACK', 'RECALL', 'LOAD_CONTEXT');

-- CreateEnum
CREATE TYPE "PageEntrySignalSource" AS ENUM ('RUN', 'PULL_REQUEST');

-- CreateEnum
CREATE TYPE "PageEntrySignalKind" AS ENUM ('HELPFUL', 'HARMFUL');

-- CreateEnum
CREATE TYPE "KnowledgeArm" AS ENUM ('TREATMENT', 'HOLDOUT');

-- CreateEnum
CREATE TYPE "AgentRunPullRequestOutcome" AS ENUM ('MERGED', 'CLOSED');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "knowledgeArm" "KnowledgeArm",
ADD COLUMN     "pullRequestClosedAt" TIMESTAMP(3),
ADD COLUMN     "pullRequestOutcome" "AgentRunPullRequestOutcome";

-- AlterTable
ALTER TABLE "AgentRunIteration" ADD COLUMN     "accepted" BOOLEAN,
ADD COLUMN     "failedChecks" JSONB;

-- AlterTable
ALTER TABLE "PageEntry" ADD COLUMN     "harmfulCount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "helpfulCount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PageEntryUse" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "sessionId" TEXT,
    "tokenId" TEXT,
    "userId" TEXT,
    "via" "PageEntryUseVia" NOT NULL,

    CONSTRAINT "PageEntryUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageEntrySignal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "entryId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "source" "PageEntrySignalSource" NOT NULL,
    "kind" "PageEntrySignalKind" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "evidence" TEXT,

    CONSTRAINT "PageEntrySignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageEntryUse_entryId_createdAt_idx" ON "PageEntryUse"("entryId", "createdAt");

-- CreateIndex
CREATE INDEX "PageEntryUse_agentRunId_idx" ON "PageEntryUse"("agentRunId");

-- CreateIndex
CREATE INDEX "PageEntryUse_workspaceId_createdAt_idx" ON "PageEntryUse"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "PageEntrySignal_agentRunId_idx" ON "PageEntrySignal"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PageEntrySignal_entryId_agentRunId_source_key" ON "PageEntrySignal"("entryId", "agentRunId", "source");

-- AddForeignKey
ALTER TABLE "PageEntryUse" ADD CONSTRAINT "PageEntryUse_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PageEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageEntryUse" ADD CONSTRAINT "PageEntryUse_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageEntrySignal" ADD CONSTRAINT "PageEntrySignal_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PageEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageEntrySignal" ADD CONSTRAINT "PageEntrySignal_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

