-- What an account is, as opposed to what it may do in a workspace. Role is
-- per-membership; this is per-account, so the UI can badge an agent as
-- non-human wherever it shows up.
ALTER TABLE "User" ADD COLUMN "type" "UserType" NOT NULL DEFAULT 'User';

-- Agents provisioned before this column existed are only identifiable by the
-- AGENT role on their membership. Backfill from that so their history and
-- assignments read as agent work rather than as a person's.
UPDATE "User"
SET "type" = 'Agent'
WHERE "id" IN (
  SELECT "userId" FROM "UsersOnWorkspaces" WHERE "role" = 'AGENT'
);

-- Same for the actions feature's bots, which the enum already has a value for.
UPDATE "User"
SET "type" = 'System'
WHERE "id" IN (
  SELECT "userId" FROM "UsersOnWorkspaces" WHERE "role" = 'BOT'
);
