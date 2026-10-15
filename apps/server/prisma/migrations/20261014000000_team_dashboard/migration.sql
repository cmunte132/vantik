-- AlterTable
-- The column starts nullable so the backfill can run before NOT NULL applies.
ALTER TABLE "Issue" ADD COLUMN     "stateEnteredAt" TIMESTAMP(3);

-- Backfill: the newest move into the current state, else the creation time.
-- updatedAt, not createdAt: the old code merged same-user edits into one row and
-- kept its createdAt, so updatedAt is the upper bound of the move time.
UPDATE "Issue" i
SET "stateEnteredAt" = COALESCE(
  (
    SELECT MAX(h."updatedAt")
    FROM "IssueHistory" h
    WHERE h."issueId" = i."id" AND h."toStateId" = i."stateId"
  ),
  i."createdAt"
);

ALTER TABLE "Issue" ALTER COLUMN "stateEnteredAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Issue" ALTER COLUMN "stateEnteredAt" SET NOT NULL;

-- CreateTable
CREATE TABLE "TeamDashboardSettings" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "teamId" TEXT NOT NULL,
    "thresholdOverrides" JSONB NOT NULL DEFAULT '{}',
    "learnedThresholds" JSONB NOT NULL DEFAULT '{}',
    "learnedAt" TIMESTAMP(3),

    CONSTRAINT "TeamDashboardSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamDashboardSettings_teamId_key" ON "TeamDashboardSettings"("teamId");

-- CreateIndex
CREATE INDEX "Issue_teamId_stateId_stateEnteredAt_idx" ON "Issue"("teamId", "stateId", "stateEnteredAt");

-- AddForeignKey
ALTER TABLE "TeamDashboardSettings" ADD CONSTRAINT "TeamDashboardSettings_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
