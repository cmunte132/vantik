-- CreateEnum
CREATE TYPE "AgentSessionLocation" AS ENUM ('LOCAL', 'HOSTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AgentSessionChannel" AS ENUM ('HOOKS', 'CONNECTOR', 'GIT_INBOX', 'HOSTED');

-- CreateEnum
CREATE TYPE "AgentSessionDriver" AS ENUM ('TERMINAL', 'VANTIK');

-- AlterEnum
ALTER TYPE "ModelName" ADD VALUE 'AgentSession';

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "workspaceId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "harness" TEXT,
    "location" "AgentSessionLocation" NOT NULL DEFAULT 'UNKNOWN',
    "channel" "AgentSessionChannel" NOT NULL,
    "driver" "AgentSessionDriver",
    "driverLeaseExpiresAt" TIMESTAMP(3),
    "parentSessionId" TEXT,
    "agentRunId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_agentRunId_key" ON "AgentSession"("agentRunId");

-- CreateIndex
CREATE INDEX "AgentSession_issueId_idx" ON "AgentSession"("issueId");

-- CreateIndex
CREATE INDEX "AgentSession_workspaceId_actorUserId_externalId_idx" ON "AgentSession"("workspaceId", "actorUserId", "externalId");

-- CreateIndex
CREATE INDEX "AgentSession_parentSessionId_idx" ON "AgentSession"("parentSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_workspaceId_actorUserId_channel_externalId_iss_key" ON "AgentSession"("workspaceId", "actorUserId", "channel", "externalId", "issueId");

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "AgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every hosted run is a session, so the issue page reads one list. The
-- session id is new; the run id is the harness session id.
INSERT INTO "AgentSession" (
    "id", "createdAt", "updatedAt", "deleted", "workspaceId", "issueId",
    "actorUserId", "externalId", "harness", "location", "channel", "driver",
    "agentRunId", "startedAt", "lastActiveAt", "endedAt"
)
SELECT
    gen_random_uuid()::text, r."createdAt", r."updatedAt", r."deleted",
    r."workspaceId", r."issueId", r."agentUserId", r."id", 'pi', 'HOSTED',
    'HOSTED', 'VANTIK', r."id", COALESCE(r."startedAt", r."createdAt"),
    COALESCE(r."finishedAt", r."updatedAt"), r."finishedAt"
FROM "AgentRun" r
JOIN "User" u ON u."id" = r."agentUserId";

-- A retried run continues the session of the attempt before it.
UPDATE "AgentSession" s
SET "parentSessionId" = p."id"
FROM "AgentRun" r
JOIN "AgentSession" p ON p."agentRunId" = r."previousRunId"
WHERE s."agentRunId" = r."id" AND r."previousRunId" IS NOT NULL;
