-- DropIndex
DROP INDEX "User_id_key";

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "supertokensUserId" TEXT NOT NULL,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_supertokensUserId_key" ON "AuthIdentity"("supertokensUserId");

-- CreateIndex
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_userId_provider_key" ON "AuthIdentity"("userId", "provider");

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill. Until now a User id *was* the SuperTokens passwordless user id, so
-- every existing account has exactly one way in and its recipe user id is that
-- same value. Without this, sessions for existing accounts resolve to nobody.
INSERT INTO "AuthIdentity" ("id", "createdAt", "updatedAt", "userId", "provider", "supertokensUserId")
SELECT gen_random_uuid()::text, now(), now(), "id", 'passwordless', "id" FROM "User";
