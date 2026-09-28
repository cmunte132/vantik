-- Pages the gardener builds, and changes to pages people keep that wait on
-- a person.
--
-- A page is AUTHORED, as every page has been, or GENERATED: built from the
-- entries in its scope to answer its question, as sections with stable ids
-- that each cite the entries they were written from. A refresh edits those
-- sections by id, and runs only once the evidence has changed since the
-- last build (its watermark, confirmed by a hash of what the evidence says,
-- as serving an entry also moves its updatedAt) and the minimum interval
-- has passed. The page keeps the entries it cites, which stay in use as its
-- evidence.
--
-- A page's history keeps the sections a change replaced beside the body, so
-- the existing revert puts both back.
--
-- An agent's consolidation into an AUTHORED page is recorded as a proposal,
-- and changes nothing until a person accepts it.
--
-- Every existing page becomes AUTHORED with no sections, cites nothing and
-- has never been built; no existing row is otherwise written.

-- CreateEnum
CREATE TYPE "PageKind" AS ENUM ('AUTHORED', 'GENERATED');

-- CreateEnum
CREATE TYPE "PageProposalState" AS ENUM ('OPEN', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "citedEntryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "evidenceHash" TEXT,
ADD COLUMN     "kind" "PageKind" NOT NULL DEFAULT 'AUTHORED',
ADD COLUMN     "question" TEXT,
ADD COLUMN     "refreshedAt" TIMESTAMP(3),
ADD COLUMN     "sections" JSONB,
ADD COLUMN     "watermark" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PageHistory" ADD COLUMN     "previousSections" JSONB;

-- CreateTable
CREATE TABLE "PageProposal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pageId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entryIds" TEXT[],
    "proposedById" TEXT,
    "state" "PageProposalState" NOT NULL DEFAULT 'OPEN',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "PageProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageProposal_pageId_state_idx" ON "PageProposal"("pageId", "state");

-- AddForeignKey
ALTER TABLE "PageProposal" ADD CONSTRAINT "PageProposal_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
