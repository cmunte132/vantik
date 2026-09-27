-- Knowledge citations: what an entry's claim rests on.
--
-- A claim about code cites lines of a file in a module's repository at a
-- commit. The server reads those lines itself and keeps them, whitespace-
-- normalised, so a later check can tell lines that moved from lines that
-- changed by comparing text, with no model involved. A decision cites the
-- issue, pull request, comment or run where it was made, and is checked for
-- existence in the workspace. Each citation records its last check: when, at
-- which commit, and the result; a changed code citation also records what a
-- judge model said and which model it was.
--
-- New table and new enums only; no existing row changes.
-- CreateEnum
CREATE TYPE "PageEntryCitationKind" AS ENUM ('CODE', 'ISSUE', 'PULL_REQUEST', 'COMMENT', 'RUN');

-- CreateEnum
CREATE TYPE "PageEntryCitationCheck" AS ENUM ('HOLDS', 'MOVED', 'CHANGED', 'MISSING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PageEntryCitationJudgment" AS ENUM ('HOLDS', 'CONTRADICTED', 'UNCLEAR');

-- CreateTable
CREATE TABLE "PageEntryCitation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "entryId" TEXT NOT NULL,
    "kind" "PageEntryCitationKind" NOT NULL,
    "moduleRepoId" TEXT,
    "path" TEXT,
    "commitSha" TEXT,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "snippet" TEXT,
    "snippetHash" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "checkedAt" TIMESTAMP(3),
    "checkedSha" TEXT,
    "checkResult" "PageEntryCitationCheck",
    "judgment" "PageEntryCitationJudgment",
    "judgeModel" TEXT,
    "judgeLines" TEXT,
    "judgeReason" TEXT,

    CONSTRAINT "PageEntryCitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageEntryCitation_entryId_idx" ON "PageEntryCitation"("entryId");

-- CreateIndex
CREATE INDEX "PageEntryCitation_moduleRepoId_path_idx" ON "PageEntryCitation"("moduleRepoId", "path");

-- CreateIndex
CREATE INDEX "PageEntryCitation_checkResult_idx" ON "PageEntryCitation"("checkResult");

-- AddForeignKey
ALTER TABLE "PageEntryCitation" ADD CONSTRAINT "PageEntryCitation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PageEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageEntryCitation" ADD CONSTRAINT "PageEntryCitation_moduleRepoId_fkey" FOREIGN KEY ("moduleRepoId") REFERENCES "ModuleRepo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

