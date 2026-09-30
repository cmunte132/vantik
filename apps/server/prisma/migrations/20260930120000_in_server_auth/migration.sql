BEGIN;

-- AlterTable: PersonalAccessToken
ALTER TABLE "vantik"."PersonalAccessToken" ADD COLUMN IF NOT EXISTS "tokenHash" TEXT;
ALTER TABLE "vantik"."PersonalAccessToken" ALTER COLUMN "token" DROP NOT NULL;

-- Backfill tokenHash from token if token exists and tokenHash is null
UPDATE "vantik"."PersonalAccessToken"
SET "tokenHash" = encode(sha256("token"::bytea), 'hex')
WHERE "token" IS NOT NULL AND "tokenHash" IS NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PersonalAccessToken_tokenHash_idx" ON "vantik"."PersonalAccessToken"("tokenHash");

-- CreateTable: Session
CREATE TABLE IF NOT EXISTS "vantik"."Session" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "role" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Session_tokenHash_key" ON "vantik"."Session"("tokenHash");
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "vantik"."Session"("userId");
CREATE INDEX IF NOT EXISTS "Session_tokenHash_idx" ON "vantik"."Session"("tokenHash");
CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx" ON "vantik"."Session"("expiresAt");

-- AddForeignKey
ALTER TABLE "vantik"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "vantik"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: EmailVerification
CREATE TABLE IF NOT EXISTS "vantik"."EmailVerification" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT,
    "linkTokenHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerification_linkTokenHash_key" ON "vantik"."EmailVerification"("linkTokenHash");
CREATE INDEX IF NOT EXISTS "EmailVerification_email_idx" ON "vantik"."EmailVerification"("email");
CREATE INDEX IF NOT EXISTS "EmailVerification_codeHash_idx" ON "vantik"."EmailVerification"("codeHash");
CREATE INDEX IF NOT EXISTS "EmailVerification_linkTokenHash_idx" ON "vantik"."EmailVerification"("linkTokenHash");
CREATE INDEX IF NOT EXISTS "EmailVerification_expiresAt_idx" ON "vantik"."EmailVerification"("expiresAt");

-- CreateTable: PasskeyCredential
CREATE TABLE IF NOT EXISTS "vantik"."PasskeyCredential" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" JSONB NOT NULL DEFAULT '[]',
    "rpId" TEXT,

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PasskeyCredential_userId_idx" ON "vantik"."PasskeyCredential"("userId");

-- AddForeignKey
ALTER TABLE "vantik"."PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "vantik"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy each legacy WebAuthn credential to its account.
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'webauthn_credentials'
    ) THEN
        INSERT INTO "vantik"."PasskeyCredential" ("id", "createdAt", "updatedAt", "userId", "publicKey", "counter", "transports", "rpId")
        SELECT
            c.id,
            to_timestamp(c.created_at / 1000.0),
            to_timestamp(c.updated_at / 1000.0),
            ai."userId",
            -- Remove the AAGUID, the length field, and the credential ID to get the COSE key.
            substring(c.public_key FROM (19 + (get_byte(c.public_key, 16) * 256 + get_byte(c.public_key, 17)))),
            c.counter,
            c.transports::jsonb,
            c.rp_id
        FROM "public"."webauthn_credentials" c
        JOIN "vantik"."AuthIdentity" ai ON c.user_id = ai."supertokensUserId"
        ON CONFLICT ("id") DO NOTHING;

        -- Stop the migration if a credential has no account or conflicts with an existing key.
        IF EXISTS (
            SELECT 1
            FROM "public"."webauthn_credentials" c
            LEFT JOIN "vantik"."AuthIdentity" ai ON c.user_id = ai."supertokensUserId"
            LEFT JOIN "vantik"."PasskeyCredential" p ON p."id" = c.id
            WHERE ai."userId" IS NULL
                OR p."userId" IS DISTINCT FROM ai."userId"
                OR p."publicKey" IS DISTINCT FROM substring(c.public_key FROM (19 + (get_byte(c.public_key, 16) * 256 + get_byte(c.public_key, 17))))
                OR p."rpId" IS DISTINCT FROM c.rp_id
        ) THEN
            RAISE EXCEPTION 'Cannot migrate all legacy WebAuthn credentials: an account is missing or a credential conflicts';
        END IF;
    END IF;
END $$;

COMMIT;
