-- Announces the sessions that 20261009000000 backfilled for existing runs.
--
-- Its own file because Postgres does not let a transaction use an enum value
-- it added itself, and 20261009000000 is the one that adds 'AgentSession' to
-- "ModelName". A client asks the log for everything above the sequence id it
-- holds, so a row that is not in the log never reaches it. The sequence has the
-- shape convertLsnToInt makes: milliseconds, times a thousand.
INSERT INTO "SyncAction" ("id", "createdAt", "updatedAt", "modelName", "modelId", "action", "sequenceId", "workspaceId", "teamId")
SELECT
    gen_random_uuid()::text,
    now(),
    now(),
    'AgentSession'::"ModelName",
    s."id",
    'I'::"ActionType",
    (extract(epoch FROM clock_timestamp()) * 1000)::bigint * 1000,
    s."workspaceId",
    i."teamId"
FROM "AgentSession" s
JOIN "Issue" i ON i."id" = s."issueId"
WHERE s."deleted" IS NULL
ON CONFLICT ("modelId", "action") DO NOTHING;
