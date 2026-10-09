-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN     "terminalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "terminalSeenAt" TIMESTAMP(3),
ADD COLUMN     "terminalTurns" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AgentSessionEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "AgentRunEventLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "phase" TEXT,
    "data" JSONB,
    "sessionId" TEXT NOT NULL,

    CONSTRAINT "AgentSessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSessionEvent_sessionId_at_idx" ON "AgentSessionEvent"("sessionId", "at");

-- AddForeignKey
ALTER TABLE "AgentSessionEvent" ADD CONSTRAINT "AgentSessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
