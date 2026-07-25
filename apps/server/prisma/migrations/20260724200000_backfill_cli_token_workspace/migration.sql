-- CLI login recorded the literal string 'cli' as the workspace a token was
-- issued for. That went unnoticed while authentication took the account's first
-- membership regardless of what the token said; now that a token acts in the
-- workspace it names, a token naming 'cli' names no workspace at all.
--
-- The authorization code that minted each of these carries the workspace that
-- was being logged into, so the real value is recoverable. Where several codes
-- point at the same token, the most recent one is the workspace it was last
-- logged into.
UPDATE "PersonalAccessToken" AS pat
SET "workspaceId" = (
  SELECT ac."workspaceId"
  FROM "AuthorizationCode" AS ac
  WHERE ac."personalAccessTokenId" = pat."id"
    AND ac."workspaceId" IS NOT NULL
  ORDER BY ac."createdAt" DESC
  LIMIT 1
)
WHERE pat."workspaceId" = 'cli'
  AND EXISTS (
    SELECT 1
    FROM "AuthorizationCode" AS ac
    WHERE ac."personalAccessTokenId" = pat."id"
      AND ac."workspaceId" IS NOT NULL
  );

-- Any token still naming 'cli' has no authorization code left to recover a
-- workspace from. It is left alone rather than guessed at: `vantik-cli login`
-- issues a new one, correctly scoped.
