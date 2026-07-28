-- Tells the clients about the rows that the seed migration wrote.
--
-- A client learns about a record from a sync action and from nothing else. The
-- server writes those actions while it reads the write-ahead log, and it drops
-- the replication slot on every start, so a migration writes its rows while
-- nobody listens. SyncRepairService does not cover this either: it repairs only
-- records that some client already heard about once, and these are new.
--
-- Without this file the seeded product is in the database, is returned by the
-- REST route, and never appears in a running client. That is the quiet failure
-- that sync-registry.spec.ts exists to catch for code, and no test catches for
-- data.
--
-- Its own migration, and not part of the seed, because the seed is already
-- applied where this repository is developed, and Prisma records a checksum for
-- every file it has run.

-- The sequence has the shape that convertLsnToInt makes: the time in
-- milliseconds, times a thousand. A client asks for everything above the
-- sequence it holds, so a value taken now sits after everything already in the
-- log and before everything the log records next.
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
ON CONFLICT ("modelId", "action") DO NOTHING;

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
ON CONFLICT ("modelId", "action") DO NOTHING;

-- The issues changed as well, and each client holds its own copy of every one of
-- them. An update action is enough: the client already has the record and reads
-- the new columns from the row that the server sends back.
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
ON CONFLICT ("modelId", "action") DO NOTHING;
