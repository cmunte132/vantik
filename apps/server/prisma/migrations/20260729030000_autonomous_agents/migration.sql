-- Everything the autonomous-agents work adds to the schema, in one migration.
--
-- Written as one file rather than the five it was developed as, because none
-- of them ever reached a database outside this branch. A migration history is
-- a record of what production has already run; steps that only ever existed
-- here are drafts, and replaying a draft — adding a column in one step to
-- widen its unique index in the next — teaches a reader nothing and costs
-- every fresh database the round trip.
--
-- Dated after the last migration on main on purpose. It alters Module, which
-- `20260727200000_add_product_module_capability` creates, and filename order
-- is the only order a migration history has.

-- The replication decoder keys sync actions off the postgres relation name, so
-- the enum backing SyncAction.modelName has to learn the new tables before any
-- of their rows can be broadcast to clients.
--
-- `20260727220000_add_agent_model_names` already declares these on main, where
-- they were needed ahead of the tables. Repeated here so this file stands on
-- its own, and harmless because both are conditional.
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'AgentRun';
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'AgentRunEvent';
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'AgentRunIteration';

-- ---------------------------------------------------------------------------
-- Agent runs: a durable record of one agent's attempt at one issue.
--
-- Vantik had agent identity (UserType.Agent, per-agent PATs) and an agent
-- surface (MCP, agent-core, the CLI), but nothing representing a unit of work
-- an agent is doing. Execution backends — a runner on a laptop, a hosted
-- sandbox, a third-party coding agent — are all writers against this record;
-- none of them owns the lifecycle.
-- ---------------------------------------------------------------------------

CREATE TYPE "AgentRunStatus" AS ENUM (
    'QUEUED',
    'CLAIMED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELED',
    'EXPIRED',
    'NEEDS_REVIEW'
);

-- Typed rather than free text, so failures are countable. An error string
-- answers "what happened to this run" and never "how often does setup break".
CREATE TYPE "AgentRunFailure" AS ENUM (
    'ENVIRONMENT_SETUP_FAILED',
    'HARNESS_CRASHED',
    'BUDGET_EXHAUSTED',
    'NO_DIFF_PRODUCED',
    'VERIFICATION_FAILED',
    'PUSH_REJECTED',
    'PR_CREATION_FAILED',
    'EGRESS_DENIED',
    'LEASE_LOST',
    'NOT_TEST_SPECIFIABLE',
    'REWARD_HACK_SUSPECTED'
);

CREATE TYPE "AgentRunEventLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "workspaceId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "createdById" TEXT,
    "executor" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "previousRunId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "summary" TEXT,
    "error" TEXT,
    "failure" "AgentRunFailure",
    "result" JSONB,
    "config" JSONB,
    "contextPack" JSONB,
    -- Reproducibility and comparison, present from the first row on purpose:
    -- added later, every run recorded before it is a permanent hole in the
    -- population and no two runs either side of it are comparable.
    "harnessVersion" TEXT,
    "modelId" TEXT,
    "configHash" TEXT,
    "iterationCount" INTEGER NOT NULL DEFAULT 0,
    "phaseTimings" JSONB,
    "baseCommit" TEXT,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRunEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the executor says it happened, which is not when we stored it.
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "AgentRunEventLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "phase" TEXT,
    "data" JSONB,
    "runId" TEXT NOT NULL,

    CONSTRAINT "AgentRunEvent_pkey" PRIMARY KEY ("id")
);

-- One pass of the ENG-62 implement/score loop. Present before the loop ships
-- for the same reason as the columns above.
CREATE TABLE "AgentRunIteration" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "validationPassRate" DOUBLE PRECISION,
    "heldOutPassRate" DOUBLE PRECISION,
    "delta" DOUBLE PRECISION,
    "verificationPassed" BOOLEAN,
    "findings" JSONB,
    "diffHash" TEXT,
    "phaseTimings" JSONB,

    CONSTRAINT "AgentRunIteration_pkey" PRIMARY KEY ("id")
);

-- The workspace view ("what is running right now") and every list filter.
CREATE INDEX "AgentRun_workspaceId_status_idx" ON "AgentRun"("workspaceId", "status");
-- The run panel on an issue.
CREATE INDEX "AgentRun_issueId_idx" ON "AgentRun"("issueId");
-- An AGENT token reads its own runs, not the workspace's.
CREATE INDEX "AgentRun_agentUserId_idx" ON "AgentRun"("agentUserId");
-- The lease sweeper's only query: live runs whose lease has lapsed.
CREATE INDEX "AgentRun_status_leaseExpiresAt_idx" ON "AgentRun"("status", "leaseExpiresAt");
-- One retry per run, so a chain of attempts cannot fork.
CREATE UNIQUE INDEX "AgentRun_previousRunId_key" ON "AgentRun"("previousRunId");

-- Tailing a run is always "events for this run, in order".
CREATE INDEX "AgentRunEvent_runId_at_idx" ON "AgentRunEvent"("runId", "at");

CREATE INDEX "AgentRunIteration_runId_idx" ON "AgentRunIteration"("runId");
CREATE UNIQUE INDEX "AgentRunIteration_runId_index_key" ON "AgentRunIteration"("runId", "index");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_previousRunId_fkey" FOREIGN KEY ("previousRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Events and iterations are meaningless without their run, and capped per run
-- anyway, so they go with it rather than being left as orphans.
ALTER TABLE "AgentRunEvent" ADD CONSTRAINT "AgentRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRunIteration" ADD CONSTRAINT "AgentRunIteration_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Workspace credentials for the hosted executor.
--
-- Two kinds, and the difference between them is the whole security design.
-- The model key has to reach the harness, so it enters the sandbox. The git
-- token never does: push and pull-request creation happen host-side on the
-- sandbox's request, so a prompt-injected agent has nothing to exfiltrate.
-- ---------------------------------------------------------------------------

CREATE TYPE "WorkspaceCredentialKind" AS ENUM ('MODEL_API_KEY', 'GIT_TOKEN');

CREATE TABLE "WorkspaceCredential" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "workspaceId" TEXT NOT NULL,
    "kind" "WorkspaceCredentialKind" NOT NULL,
    -- Which model provider a MODEL_API_KEY belongs to — `anthropic`, `openai`,
    -- `openrouter` and so on. This is what tells the executor which
    -- environment variable to hand the key to the harness under: Pi has no
    -- generic key variable, it reads ANTHROPIC_API_KEY, OPENAI_API_KEY and the
    -- rest by name, so a key with no provider is a key the harness cannot use.
    --
    -- Empty for a GIT_TOKEN, which has no provider. Empty rather than null so
    -- the unique index below actually constrains it — postgres treats nulls as
    -- distinct, so a nullable column here would allow unlimited duplicates.
    "provider" TEXT NOT NULL DEFAULT '',
    -- AES-256-GCM under a key derived from the server secret. No endpoint
    -- returns these three columns.
    "ciphertext" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    -- The last few characters only, so a human can tell one key from another
    -- without the API ever handing back a secret.
    "hint" TEXT NOT NULL,
    -- The account's own endpoint, for a provider that has one per customer.
    -- Most have a single fixed host and leave this empty.
    "baseUrl" TEXT,
    -- What the key could reach when it was last checked, and when. Cached so
    -- the settings screen can name the models a key offers without calling the
    -- provider on every render.
    "models" JSONB,
    "modelsCheckedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceCredential_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkspaceCredential_workspaceId_idx" ON "WorkspaceCredential"("workspaceId");

-- One key per provider, not one in total: a workspace runs Claude on one issue
-- and a cheaper model on another, and rotation replaces rather than
-- accumulates, so there is never ambiguity about which key a run used. Empty
-- provider for a GIT_TOKEN is a real value, so this still allows exactly one
-- of those per workspace.
CREATE UNIQUE INDEX "WorkspaceCredential_workspaceId_kind_provider_key" ON "WorkspaceCredential"("workspaceId", "kind", "provider");

ALTER TABLE "WorkspaceCredential" ADD CONSTRAINT "WorkspaceCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- When a token last authenticated a request.
--
-- Null means never used, which is the whole point: an agent account that has
-- never made a request is a leftover, and until now nothing could tell one
-- from an account in daily use.
-- ---------------------------------------------------------------------------

ALTER TABLE "PersonalAccessToken" ADD COLUMN "lastUsedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- How an agent run checks work in a module: setup, test, lint, typecheck and
-- build commands.
--
-- Per module rather than per workspace, because the command depends on the
-- code and on nothing else. One workspace holds a Go service and a pnpm
-- monorepo, and there is no single `testCommand` that is right for both.
-- ---------------------------------------------------------------------------

ALTER TABLE "Module" ADD COLUMN "verification" JSONB;
