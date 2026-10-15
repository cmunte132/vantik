-- AlterTable
ALTER TABLE "TeamDashboardSettings" ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "lastAnalysisAt" TIMESTAMP(3),
ADD COLUMN     "nextAnalysisAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StuckIssueFinding" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "issueId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "stateId" TEXT NOT NULL,
    "stateEnteredAt" TIMESTAMP(3) NOT NULL,
    "cause" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "suggestions" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "model" TEXT,

    CONSTRAINT "StuckIssueFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StuckIssueFinding_issueId_key" ON "StuckIssueFinding"("issueId");

-- CreateIndex
CREATE INDEX "StuckIssueFinding_teamId_idx" ON "StuckIssueFinding"("teamId");

-- AddForeignKey
ALTER TABLE "StuckIssueFinding" ADD CONSTRAINT "StuckIssueFinding_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StuckIssueFinding" ADD CONSTRAINT "StuckIssueFinding_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
