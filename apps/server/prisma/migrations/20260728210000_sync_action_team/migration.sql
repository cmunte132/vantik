-- Records the team of every announced record, and backfills the ones already
-- announced.
--
-- A team is a visibility boundary (ENG-79). The sync engine is where that has
-- to hold, because a client holds whatever the bootstrap and the deltas give
-- it, whatever the screens then choose to draw. Both of those read SyncAction,
-- and SyncAction carried only a workspace — so the filter needs a team on the
-- row.
--
-- The column is nullable, and null means "no team owns this". A workspace-wide
-- record, such as a Label or a Page, is announced to everyone in the workspace
-- and keeps a null team.
--
-- The backfill matters as much as the column. Without it every row announced
-- before this migration keeps a null team, which reads as "everyone may see
-- it" — the boundary would then hold for new writes and leak the entire
-- history behind them.

ALTER TABLE "SyncAction" ADD COLUMN "teamId" TEXT;

-- A team owns itself.
UPDATE "SyncAction" AS s
SET "teamId" = t."id"
FROM "Team" AS t
WHERE s."modelName" = 'Team' AND s."modelId" = t."id";

-- The three models that name their team directly.
UPDATE "SyncAction" AS s
SET "teamId" = i."teamId"
FROM "Issue" AS i
WHERE s."modelName" = 'Issue' AND s."modelId" = i."id";

UPDATE "SyncAction" AS s
SET "teamId" = c."teamId"
FROM "Cycle" AS c
WHERE s."modelName" = 'Cycle' AND s."modelId" = c."id";

UPDATE "SyncAction" AS s
SET "teamId" = w."teamId"
FROM "Workflow" AS w
WHERE s."modelName" = 'Workflow' AND s."modelId" = w."id";

-- Everything that hangs off an issue takes the team of that issue. These carry
-- the content that the boundary is about: a comment body is worth more to a
-- reader who must not see it than the issue title is.
UPDATE "SyncAction" AS s
SET "teamId" = i."teamId"
FROM "IssueComment" AS c
JOIN "Issue" AS i ON i."id" = c."issueId"
WHERE s."modelName" = 'IssueComment' AND s."modelId" = c."id";

UPDATE "SyncAction" AS s
SET "teamId" = i."teamId"
FROM "ChecklistItem" AS ci
JOIN "Issue" AS i ON i."id" = ci."issueId"
WHERE s."modelName" = 'ChecklistItem' AND s."modelId" = ci."id";

UPDATE "SyncAction" AS s
SET "teamId" = i."teamId"
FROM "IssueHistory" AS h
JOIN "Issue" AS i ON i."id" = h."issueId"
WHERE s."modelName" = 'IssueHistory' AND s."modelId" = h."id";

UPDATE "SyncAction" AS s
SET "teamId" = i."teamId"
FROM "LinkedIssue" AS l
JOIN "Issue" AS i ON i."id" = l."issueId"
WHERE s."modelName" = 'LinkedIssue' AND s."modelId" = l."id";

UPDATE "SyncAction" AS s
SET "teamId" = i."teamId"
FROM "IssueRelation" AS r
JOIN "Issue" AS i ON i."id" = r."issueId"
WHERE s."modelName" = 'IssueRelation' AND s."modelId" = r."id";

UPDATE "SyncAction" AS s
SET "teamId" = i."teamId"
FROM "Support" AS sup
JOIN "Issue" AS i ON i."id" = sup."issueId"
WHERE s."modelName" = 'Support' AND s."modelId" = sup."id";

-- An issue suggestion is reached from the other side: the issue names the
-- suggestion, and the suggestion does not name the issue.
UPDATE "SyncAction" AS s
SET "teamId" = i."teamId"
FROM "Issue" AS i
WHERE s."modelName" = 'IssueSuggestion' AND s."modelId" = i."issueSuggestionId";

-- The read asks for one workspace, a set of teams, and a sequence id above the
-- one the client holds. That is the order of this index.
CREATE INDEX "SyncAction_workspaceId_teamId_sequenceId_idx"
  ON "SyncAction"("workspaceId", "teamId", "sequenceId");
