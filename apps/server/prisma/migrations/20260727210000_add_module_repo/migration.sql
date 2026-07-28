-- Where the code of a module is.
--
-- Deliberately not in the ModelName enum and not replicated. Only the server
-- reads it, once for each webhook, to find the module from the repository and
-- from the paths of the changed files. The module page asks for these rows in a
-- plain request, so the sync log carries none of them.
--
-- pathPrefixes is what makes a monorepo and a set of small repositories the same
-- shape. An empty list means the module is all of the repository. A monorepo
-- becomes several modules on one repository, each with its own prefixes, and
-- nothing else in the model has to know which of the two it is looking at.

CREATE TABLE "ModuleRepo" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" TIMESTAMP(3),
    "moduleId" TEXT NOT NULL,
    "integrationAccountId" TEXT,
    "externalRepoId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "pathPrefixes" TEXT[],
    "bidirectional" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ModuleRepo_pkey" PRIMARY KEY ("id")
);

-- Every read is either "the repositories of this module", for the page, or "the
-- modules of this repository", for a webhook.
CREATE INDEX "ModuleRepo_moduleId_idx" ON "ModuleRepo"("moduleId");
CREATE INDEX "ModuleRepo_externalRepoId_idx" ON "ModuleRepo"("externalRepoId");

ALTER TABLE "ModuleRepo" ADD CONSTRAINT "ModuleRepo_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
