-- Knowledge audit: human verdicts on triage decisions, audits, and back-off.
--
-- A triage decision gains what a person did once the entry reached them
-- (accepted, rejected or edited it), whether that agreed with the decision,
-- who and when; whether it was drawn for audit and at what rate; and, when
-- its decision type was backed off, the decision it reached. Agreement
-- between triage and people is measured from these, per decision type.
--
-- KnowledgeBackoffChange records each time a decision type stops or resumes
-- acting on its own in a workspace, with the agreement it was decided on.
-- LOW_AGREEMENT is the reason a backed-off decision escalates with.
--
-- A new enum value, a new enum, a new table, and new nullable or defaulted
-- columns. No existing row is written.
-- CreateEnum
CREATE TYPE "KnowledgeVerdict" AS ENUM ('ACCEPTED', 'REJECTED', 'EDITED');

-- AlterEnum
ALTER TYPE "KnowledgeEscalationReason" ADD VALUE 'LOW_AGREEMENT';

-- AlterTable
ALTER TABLE "KnowledgeTriageDecision" ADD COLUMN     "agreed" BOOLEAN,
ADD COLUMN     "audit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "auditRate" DOUBLE PRECISION,
ADD COLUMN     "backedOffFrom" "KnowledgeTriageDecisionType",
ADD COLUMN     "verdict" "KnowledgeVerdict",
ADD COLUMN     "verdictAt" TIMESTAMP(3),
ADD COLUMN     "verdictById" TEXT;

-- CreateTable
CREATE TABLE "KnowledgeBackoffChange" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,
    "decision" "KnowledgeTriageDecisionType" NOT NULL,
    "backedOff" BOOLEAN NOT NULL,
    "kappa" DOUBLE PRECISION,
    "samples" INTEGER NOT NULL,
    "floor" DOUBLE PRECISION NOT NULL,
    "minSamples" INTEGER NOT NULL,
    "windowDays" INTEGER NOT NULL,

    CONSTRAINT "KnowledgeBackoffChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeBackoffChange_workspaceId_decision_createdAt_idx" ON "KnowledgeBackoffChange"("workspaceId", "decision", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeTriageDecision_workspaceId_verdictAt_idx" ON "KnowledgeTriageDecision"("workspaceId", "verdictAt");

