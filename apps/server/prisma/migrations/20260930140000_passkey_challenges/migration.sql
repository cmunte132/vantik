CREATE TYPE "vantik"."PasskeyChallengeOperation" AS ENUM ('SIGNUP', 'REGISTER', 'SIGNIN');

CREATE TABLE "vantik"."PasskeyChallenge" (
    "challenge" TEXT NOT NULL,
    "operation" "vantik"."PasskeyChallengeOperation" NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasskeyChallenge_pkey" PRIMARY KEY ("challenge")
);

CREATE INDEX "PasskeyChallenge_expiresAt_idx" ON "vantik"."PasskeyChallenge"("expiresAt");
