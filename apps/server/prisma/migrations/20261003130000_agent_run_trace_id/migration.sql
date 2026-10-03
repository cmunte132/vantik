-- The OpenTelemetry trace an agent run reported to.
ALTER TABLE "AgentRun" ADD COLUMN "traceId" TEXT;
