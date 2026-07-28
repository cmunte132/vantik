-- Re-announces the issues that the seed migration gave a module.
--
-- 20260727200200 wrote those announcements with ON CONFLICT DO NOTHING, and for
-- the issues that was the one thing it could not do. SyncAction is unique on
-- (modelId, action) and the running server *upserts*, bumping sequenceId every
-- time — that bump is the whole mechanism, because a client asks for everything
-- above the sequence id it already holds. Almost every issue has been updated at
-- least once and so already had a 'U' row, so DO NOTHING left the old sequence
-- id in place and no client ever re-read the issue. The seeded moduleIds reached
-- the database and stopped there.
--
-- Nothing else rescues it. The Dexie bump from 22 to 23 upgrades a client's
-- store in place rather than wiping it, so the stale issue rows survive, and
-- SyncRepairService only repairs records a client already heard about at a
-- sequence id it can compare.
--
-- Its own file rather than an edit to 20260727200200, because Prisma records a
-- checksum for every migration it has run and rewriting an applied one breaks
-- every database that has it.

-- The sequence has the shape convertLsnToInt makes: milliseconds, times a
-- thousand. Taken now, it sits after everything already in the log.
INSERT INTO "SyncAction" ("id", "createdAt", "updatedAt", "modelName", "modelId", "action", "sequenceId", "workspaceId")
SELECT
    gen_random_uuid()::text,
    now(),
    now(),
    'Issue'::"ModelName",
    i."id",
    'U'::"ActionType",
    (extract(epoch FROM clock_timestamp()) * 1000)::bigint * 1000,
    t."workspaceId"
FROM "Issue" i
JOIN "Team" t ON t."id" = i."teamId"
WHERE i."deleted" IS NULL
  AND coalesce(cardinality(i."moduleIds"), 0) > 0
ON CONFLICT ("modelId", "action") DO UPDATE
  SET "sequenceId" = EXCLUDED."sequenceId",
      "updatedAt" = now();

-- The same correction for the product and module rows. Those were new uuids
-- when the earlier file ran, so DO NOTHING was harmless there — unless the
-- migration was applied twice against one database, or a row was announced by
-- the replication decoder in between. Making both statements say what they mean
-- costs nothing and removes the question.
INSERT INTO "SyncAction" ("id", "createdAt", "updatedAt", "modelName", "modelId", "action", "sequenceId", "workspaceId")
SELECT
    gen_random_uuid()::text,
    now(),
    now(),
    'Product'::"ModelName",
    p."id",
    'I'::"ActionType",
    (extract(epoch FROM clock_timestamp()) * 1000)::bigint * 1000,
    p."workspaceId"
FROM "Product" p
WHERE p."deleted" IS NULL
ON CONFLICT ("modelId", "action") DO UPDATE
  SET "sequenceId" = EXCLUDED."sequenceId",
      "updatedAt" = now();

INSERT INTO "SyncAction" ("id", "createdAt", "updatedAt", "modelName", "modelId", "action", "sequenceId", "workspaceId")
SELECT
    gen_random_uuid()::text,
    now(),
    now(),
    'Module'::"ModelName",
    m."id",
    'I'::"ActionType",
    (extract(epoch FROM clock_timestamp()) * 1000)::bigint * 1000,
    m."workspaceId"
FROM "Module" m
WHERE m."deleted" IS NULL
ON CONFLICT ("modelId", "action") DO UPDATE
  SET "sequenceId" = EXCLUDED."sequenceId",
      "updatedAt" = now();
