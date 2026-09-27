-- Knowledge triage: a decision for every new entry, and relations between
-- entries instead of edits to them.
--
-- KnowledgeTriageDecision records what triage decided about an entry (accept,
-- corroborate, escalate with its reasons, reject with the policy broken), in
-- shadow mode or acted on, with its inputs, the models asked and what they
-- answered. PageEntryRelation records how a newer entry relates to an existing
-- one (duplicate, refines, supersedes, contradicts, distinct) and what decided
-- it. An entry gains the hash exact repeats are found by, and a count of the
-- repeats that corroborated it.
--
-- New tables, new enums and new nullable or defaulted columns. The only
-- existing rows written are the entries' hashes, filled in below.
-- CreateEnum
CREATE TYPE "KnowledgeTriageDecisionType" AS ENUM ('AUTO_ACCEPT', 'CORROBORATE', 'ESCALATE', 'REJECT');

-- CreateEnum
CREATE TYPE "KnowledgeEscalationReason" AS ENUM ('CONTRADICTS_VERIFIED', 'CONTRADICTS_LOCKED', 'UNGROUNDED', 'CITATION_FAILED', 'PIN_REQUEST', 'SUPERSEDE_REQUEST', 'BROAD_SCOPE', 'JUDGES_DISAGREE', 'NO_LLM', 'EXTERNAL_INPUT', 'HARMFUL_SIGNAL', 'AUDIT');

-- CreateEnum
CREATE TYPE "KnowledgeTriagePolicy" AS ENUM ('SECRET', 'ONE_FACT');

-- CreateEnum
CREATE TYPE "KnowledgeTriageMode" AS ENUM ('SHADOW', 'ON');

-- CreateEnum
CREATE TYPE "PageEntryRelationType" AS ENUM ('DUPLICATE', 'REFINES', 'SUPERSEDES', 'CONTRADICTS', 'DISTINCT');

-- CreateEnum
CREATE TYPE "PageEntryRelationDecider" AS ENUM ('HASH', 'RULE', 'MODEL');

-- AlterTable
ALTER TABLE "PageEntry" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "corroborationCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "KnowledgeTriageDecision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "decision" "KnowledgeTriageDecisionType" NOT NULL,
    "reasons" "KnowledgeEscalationReason"[] DEFAULT ARRAY[]::"KnowledgeEscalationReason"[],
    "policy" "KnowledgeTriagePolicy",
    "mode" "KnowledgeTriageMode" NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "corroboratedEntryId" TEXT,
    "inputs" JSONB NOT NULL,
    "inputsDigest" TEXT NOT NULL,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outputs" JSONB,

    CONSTRAINT "KnowledgeTriageDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageEntryRelation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "type" "PageEntryRelationType" NOT NULL,
    "decidedBy" "PageEntryRelationDecider" NOT NULL,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "similarity" DOUBLE PRECISION,
    "preferredId" TEXT,
    "reason" TEXT,

    CONSTRAINT "PageEntryRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeTriageDecision_entryId_createdAt_idx" ON "KnowledgeTriageDecision"("entryId", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeTriageDecision_workspaceId_createdAt_idx" ON "KnowledgeTriageDecision"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "PageEntryRelation_toId_idx" ON "PageEntryRelation"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "PageEntryRelation_fromId_toId_key" ON "PageEntryRelation"("fromId", "toId");

-- CreateIndex
CREATE INDEX "PageEntry_contentHash_idx" ON "PageEntry"("contentHash");

-- AddForeignKey
ALTER TABLE "KnowledgeTriageDecision" ADD CONSTRAINT "KnowledgeTriageDecision_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PageEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageEntryRelation" ADD CONSTRAINT "PageEntryRelation_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "PageEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageEntryRelation" ADD CONSTRAINT "PageEntryRelation_toId_fkey" FOREIGN KEY ("toId") REFERENCES "PageEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: existing entries get their hash, so a new entry that repeats one
-- written before this migration is found. The form is `normaliseContent`'s:
-- trimmed, runs of whitespace folded to one space, lower-cased. Postgres and
-- JavaScript agree on this for ASCII; an entry where they differ (unusual
-- Unicode whitespace or case) is not found by its hash, and the near-match
-- stage, which compares meaning rather than bytes, still finds it.
UPDATE "PageEntry"
SET "contentHash" = encode(
  sha256(convert_to(lower(regexp_replace(btrim("content", E' \t\n\r\f\v'), '\s+', ' ', 'g')), 'UTF8')),
  'hex'
)
WHERE "contentHash" IS NULL;
