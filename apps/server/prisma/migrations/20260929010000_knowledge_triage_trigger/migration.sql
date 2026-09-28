-- CreateEnum
CREATE TYPE "KnowledgeTriageTrigger" AS ENUM ('WRITTEN', 'CITATIONS_CHECKED', 'CODE_CHANGED', 'RELATED', 'VERIFIER');

-- AlterTable
ALTER TABLE "KnowledgeTriageDecision" ADD COLUMN     "trigger" "KnowledgeTriageTrigger" NOT NULL DEFAULT 'WRITTEN';
