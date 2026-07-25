-- Every request authenticated by a personal access token looks the token up by
-- value, and an agent's requests are the ones on the hot path: the MCP endpoint
-- resolves the token, and the scope guard resolves it again. The only index on
-- this table was the (name, userId, token) uniqueness constraint, which a lookup
-- on token alone cannot use, so each of those was a sequential scan over every
-- token ever issued.
CREATE INDEX IF NOT EXISTS "PersonalAccessToken_token_idx" ON "PersonalAccessToken"("token");
