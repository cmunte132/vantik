-- A second axis beside Team, so that one workspace can hold many products in
-- many repositories.
--
-- A workspace is a tenancy. Team did four jobs at the same time: it was the
-- permission boundary, it held the cycles, it was the namespace for the issue
-- numbers, and it stood for the product. This migration takes the fourth job
-- away and leaves the other three where they are.
--
-- Product groups the modules and holds no code. Module is usually one
-- repository. Capability is what the software does, and it names the modules
-- that hold its code. Containment (product to module) and realisation
-- (capability to modules) are two different graphs. One tree cannot hold both.

-- The replication decoder keys sync actions off the postgres relation name, so
-- the enum behind SyncAction.modelName must learn the new tables before any of
-- their rows can go to a client.
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'Product';
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'Module';
ALTER TYPE "ModelName" ADD VALUE IF NOT EXISTS 'Capability';

CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "leadUserId" TEXT,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Module" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "leadUserId" TEXT,
    "ownerTeamId" TEXT,
    "ownerProductId" TEXT,
    "linkedTeamIds" TEXT[],
    "linkedProductIds" TEXT[],
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "Module_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Capability" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT,
    "moduleIds" TEXT[],
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Product_workspaceId_key_key" ON "Product"("workspaceId", "key");
CREATE UNIQUE INDEX "Module_workspaceId_key_key" ON "Module"("workspaceId", "key");
CREATE UNIQUE INDEX "Capability_workspaceId_name_key" ON "Capability"("workspaceId", "name");

-- The sidebar asks for the modules of one product, and a team page asks for the
-- modules of one team. Both reads narrow by workspace first.
CREATE INDEX "Module_workspaceId_ownerProductId_idx" ON "Module"("workspaceId", "ownerProductId");
CREATE INDEX "Module_workspaceId_ownerTeamId_idx" ON "Module"("workspaceId", "ownerTeamId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Module" ADD CONSTRAINT "Module_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Module" ADD CONSTRAINT "Module_ownerTeamId_fkey" FOREIGN KEY ("ownerTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Module" ADD CONSTRAINT "Module_ownerProductId_fkey" FOREIGN KEY ("ownerProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A Module must have one owner, and only one owner. Prisma cannot say this, so
-- the database says it. Without this constraint the rule is only an agreement
-- between the developers, and an integration writes a row that breaks it.
ALTER TABLE "Module" ADD CONSTRAINT "Module_single_owner"
  CHECK (num_nonnulls("ownerTeamId", "ownerProductId") = 1);

-- The modules that an issue changes, and the one capability that it serves.
-- Both are empty for every row that exists now. The second migration fills in
-- the modules where one repository maps to one team, and leaves the rest empty.
ALTER TABLE "Issue" ADD COLUMN "moduleIds" TEXT[];
ALTER TABLE "Issue" ADD COLUMN "capabilityId" TEXT;
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The LLM writes here, and never to Issue.moduleIds. A person accepts the
-- suggestion first.
ALTER TABLE "IssueSuggestion" ADD COLUMN "suggestedModuleIds" TEXT[];

ALTER TABLE "Project" ADD COLUMN "capabilityIds" TEXT[];
