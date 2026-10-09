-- CreateEnum
CREATE TYPE "AgentQuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ModelName" ADD VALUE 'AgentQuestion';

-- CreateTable
CREATE TABLE "AgentQuestion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "workspaceId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "agentSessionId" TEXT,
    "externalId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'tool',
    "questions" JSONB NOT NULL,
    "status" "AgentQuestionStatus" NOT NULL DEFAULT 'OPEN',
    "answers" JSONB,
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "assigneeId" TEXT NOT NULL,

    CONSTRAINT "AgentQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentQuestion_issueId_idx" ON "AgentQuestion"("issueId");

-- CreateIndex
CREATE INDEX "AgentQuestion_assigneeId_status_idx" ON "AgentQuestion"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "AgentQuestion_status_expiresAt_idx" ON "AgentQuestion"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentQuestion_agentRunId_externalId_key" ON "AgentQuestion"("agentRunId", "externalId");

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AlterEnum
ALTER TYPE "NotificationActionType" ADD VALUE 'AgentQuestionAsked';
