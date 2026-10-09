-- AlterTable
ALTER TABLE "PersonalAccessToken" ADD COLUMN     "agentRunId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PersonalAccessToken_agentRunId_idx" ON "PersonalAccessToken"("agentRunId");

-- AddForeignKey
ALTER TABLE "PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
