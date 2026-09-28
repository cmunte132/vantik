-- Knowledge upkeep: keeping entries true as the code and the product change.
--
-- PageEntryMaintenance records what the gardener did to an entry on its own
-- (disputed a claim the code now contradicts, disabled a convention whose
-- outcomes went against it) and what it asks a person to do (archive an
-- entry whose cited file is gone, one no judge could read, or a verified one
-- nobody uses), with the evidence it rested on. A proposal carries its state
-- and who resolved it; a change made alone records who undid it.
--
-- KnowledgeFinding holds one reviewer finding per agent run and module, so
-- findings repeated across runs can be counted and proposed as a convention.
--
-- A knowledge gap gains the issue opened to answer it, the module it resolved
-- to, and when an accepted entry citing that issue answered it.
--
-- New enums, two new tables, and new nullable columns. No existing row is
-- written.
-- CreateEnum
CREATE TYPE "PageEntryMaintenanceAction" AS ENUM ('DISPUTED', 'ARCHIVED', 'ARCHIVE_PROPOSED');

-- CreateEnum
CREATE TYPE "PageEntryMaintenanceReason" AS ENUM ('CITATION_CONTRADICTED', 'CITATION_MISSING', 'CITATION_UNJUDGED', 'UNUSED', 'HARMFUL_SIGNALS');

-- CreateEnum
CREATE TYPE "PageEntryProposalState" AS ENUM ('OPEN', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "PageKnowledgeGap" ADD COLUMN     "answeredAt" TIMESTAMP(3),
ADD COLUMN     "answeredByEntryId" TEXT,
ADD COLUMN     "issueId" TEXT,
ADD COLUMN     "moduleId" TEXT;

-- CreateTable
CREATE TABLE "PageEntryMaintenance" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "action" "PageEntryMaintenanceAction" NOT NULL,
    "reason" "PageEntryMaintenanceReason" NOT NULL,
    "evidence" JSONB,
    "issueId" TEXT,
    "proposalState" "PageEntryProposalState",
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "PageEntryMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFinding" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "words" TEXT[],
    "key" TEXT NOT NULL,
    "evidence" TEXT,
    "path" TEXT,
    "line" INTEGER,
    "candidateId" TEXT,

    CONSTRAINT "KnowledgeFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageEntryMaintenance_workspaceId_proposalState_idx" ON "PageEntryMaintenance"("workspaceId", "proposalState");

-- CreateIndex
CREATE INDEX "PageEntryMaintenance_entryId_action_idx" ON "PageEntryMaintenance"("entryId", "action");

-- CreateIndex
CREATE INDEX "KnowledgeFinding_workspaceId_moduleId_createdAt_idx" ON "KnowledgeFinding"("workspaceId", "moduleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFinding_agentRunId_key_key" ON "KnowledgeFinding"("agentRunId", "key");

-- AddForeignKey
ALTER TABLE "PageEntryMaintenance" ADD CONSTRAINT "PageEntryMaintenance_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PageEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFinding" ADD CONSTRAINT "KnowledgeFinding_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFinding" ADD CONSTRAINT "KnowledgeFinding_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "PageEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

