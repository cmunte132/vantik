-- Retire every standing credential held by a workspace-owned agent.
--
-- Ownership now decides whether an agent credential is ever human-visible. A
-- personal agent's token is the product — somebody pastes it into `.mcp.json`
-- or a runner daemon. A workspace agent belongs to no individual, so a token
-- issued to one has unbounded blast radius, no expiry, and nobody whose job it
-- is to rotate it. `createAgentAccount` no longer mints one.
--
-- That change only governs agents provisioned after it. Any workspace agent
-- provisioned before this migration is still holding a live token, and it is
-- exactly the credential the rule exists to remove — so the rule has to be
-- applied backwards as well as forwards, or the hole stays open on every
-- deployment that already used the feature.
--
-- Soft-deleted rather than deleted outright, which is what `revokeAgent` does
-- and for the same reason: `resolvePatPrincipal` filters on `deleted IS NULL`,
-- so stamping the column is what stops the token authenticating, while the row
-- survives to explain why an agent that used to work no longer does.
--
-- The identity is deliberately untouched. The agent keeps its user record, its
-- membership and its AGENT role, so every issue it filed and every comment it
-- wrote stays attributed to it. What it loses is the ability to act.
--
-- Scoped by `type = 'agent'` so a person's own PATs can never be caught by
-- this, and joined through the membership because ownership is recorded there
-- rather than on the token. Run identities minted by `provisionRunIdentity`
-- also read as workspace-owned, and match nothing here — they were never given
-- a token to retire.
UPDATE "PersonalAccessToken" AS pat
SET deleted = NOW()
FROM "UsersOnWorkspaces" AS uow
WHERE pat."userId" = uow."userId"
  AND pat."workspaceId" = uow."workspaceId"
  AND pat.type = 'agent'
  AND pat.deleted IS NULL
  AND uow.settings #>> '{agent,ownership}' = 'workspace';
