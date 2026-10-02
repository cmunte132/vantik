-- AlterEnum
ALTER TYPE "KnowledgeTriageDecisionType" ADD VALUE 'PROVISIONAL';

-- AlterEnum
ALTER TYPE "KnowledgeTriagePolicy" ADD VALUE 'CONTRADICTED';
ALTER TYPE "KnowledgeTriagePolicy" ADD VALUE 'OUTRANKED';

-- AlterTable
ALTER TABLE "PageEntry" ADD COLUMN "provisionalSince" TIMESTAMP(3);
