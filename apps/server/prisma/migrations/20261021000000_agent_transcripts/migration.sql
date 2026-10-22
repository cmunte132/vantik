-- Canonical personal usage record for each root omp session, and one claimed row
-- per call or task inside it. Additive: no existing table is reset or copied.
ALTER TABLE "AgentSession" ADD COLUMN "terminalUnknownCalls" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AgentTranscript" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "harness" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "lastAt" TIMESTAMP(3),
    "knownCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unattributedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unknownCallCount" INTEGER NOT NULL DEFAULT 0,
    "billingSummary" JSONB NOT NULL DEFAULT '{}',
    "sources" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AgentTranscript_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentTranscript_workspaceId_actorUserId_harness_externalId_key" ON "AgentTranscript"("workspaceId", "actorUserId", "harness", "externalId");
CREATE INDEX "AgentTranscript_workspaceId_actorUserId_lastAt_idx" ON "AgentTranscript"("workspaceId", "actorUserId", "lastAt");

ALTER TABLE "AgentTranscript" ADD CONSTRAINT "AgentTranscript_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTranscript" ADD CONSTRAINT "AgentTranscript_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AgentTranscriptCall" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transcriptId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "at" TIMESTAMP(3),
    "issueId" TEXT,
    "costUsd" DOUBLE PRECISION,
    "billingMode" TEXT NOT NULL,
    "costBasis" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "AgentTranscriptCall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentTranscriptCall_transcriptId_callId_key" ON "AgentTranscriptCall"("transcriptId", "callId");
CREATE INDEX "AgentTranscriptCall_transcriptId_kind_at_idx" ON "AgentTranscriptCall"("transcriptId", "kind", "at");
CREATE INDEX "AgentTranscriptCall_transcriptId_issueId_idx" ON "AgentTranscriptCall"("transcriptId", "issueId");

ALTER TABLE "AgentTranscriptCall" ADD CONSTRAINT "AgentTranscriptCall_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "AgentTranscript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step keys: a replayed step is one row. Rows written before this have no key,
-- and NULL keys never collide in a unique index, so they are kept as they are.
ALTER TABLE "AgentRunEvent" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "AgentRunEvent_runId_sourceKey_key" ON "AgentRunEvent"("runId", "sourceKey");
ALTER TABLE "AgentSessionEvent" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "AgentSessionEvent_sessionId_sourceKey_key" ON "AgentSessionEvent"("sessionId", "sourceKey");
