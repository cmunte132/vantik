-- CreateEnum
CREATE TYPE "KnowledgeJobTrigger" AS ENUM ('SCHEDULE', 'EVENT', 'BOOT');

-- CreateTable
CREATE TABLE "KnowledgeJobRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "job" TEXT NOT NULL,
    "trigger" "KnowledgeJobTrigger" NOT NULL,
    "subjectId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "counts" JSONB,
    "error" TEXT,

    CONSTRAINT "KnowledgeJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgePackTrace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,
    "via" "PageEntryUseVia" NOT NULL,
    "agentRunId" TEXT,
    "arm" "KnowledgeArm",
    "issueId" TEXT,
    "userId" TEXT,
    "sessionId" TEXT,
    "query" TEXT NOT NULL,
    "seedModuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "neighbourModuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topK" INTEGER,
    "tokenBudget" INTEGER NOT NULL,
    "tokensGiven" INTEGER NOT NULL DEFAULT 0,
    "searchFailed" BOOLEAN NOT NULL DEFAULT false,
    "candidates" JSONB NOT NULL,

    CONSTRAINT "KnowledgePackTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeJobRun_workspaceId_job_startedAt_idx" ON "KnowledgeJobRun"("workspaceId", "job", "startedAt");

-- CreateIndex
CREATE INDEX "KnowledgeJobRun_job_startedAt_idx" ON "KnowledgeJobRun"("job", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgePackTrace_agentRunId_key" ON "KnowledgePackTrace"("agentRunId");

-- CreateIndex
CREATE INDEX "KnowledgePackTrace_workspaceId_createdAt_idx" ON "KnowledgePackTrace"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "KnowledgePackTrace" ADD CONSTRAINT "KnowledgePackTrace_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

