-- Trims the dashes off the ends of the keys the seed migration wrote.
--
-- The seed derived a key in SQL with regexp_replace, and that turned every run
-- of other characters into a dash without removing the ones it left at the ends.
-- `toKey` in the server does remove them, so a repository called ".github"
-- became "-github" from the migration and "github" from the application, and the
-- same name gave two different keys depending on which one made the row. The key
-- is in the URL of a module page, so this is visible and not only untidy.
--
-- Two rows can want the same key after the trim: "api-" and "-api-" both become
-- "api". So one row per key is chosen — the oldest, then by id, which is stable
-- — and the rest keep the key they have. A key that another row already holds is
-- skipped for the same reason. Postgres would refuse the whole statement on the
-- unique index otherwise, and a key with a dash on the end is a smaller problem
-- than a migration that will not apply.

WITH candidate AS (
    SELECT
        m."id",
        m."workspaceId" AS workspace_id,
        trim(both '-' from m."key") AS target,
        row_number() OVER (
            PARTITION BY m."workspaceId", trim(both '-' from m."key")
            ORDER BY m."createdAt", m."id"
        ) AS rank
    FROM "Module" m
    WHERE m."key" <> trim(both '-' from m."key")
      AND trim(both '-' from m."key") <> ''
)
UPDATE "Module" m
SET "key" = c.target
FROM candidate c
WHERE c."id" = m."id"
  AND c.rank = 1
  AND NOT EXISTS (
      SELECT 1
      FROM "Module" other
      WHERE other."workspaceId" = c.workspace_id
        AND other."id" <> c."id"
        AND other."key" = c.target
  );

-- The same shape reached Product only through a workspace slug, which is already
-- a key. This runs anyway, because the column has the same constraint and the
-- statement costs one scan of a small table.
WITH candidate AS (
    SELECT
        p."id",
        p."workspaceId" AS workspace_id,
        trim(both '-' from p."key") AS target,
        row_number() OVER (
            PARTITION BY p."workspaceId", trim(both '-' from p."key")
            ORDER BY p."createdAt", p."id"
        ) AS rank
    FROM "Product" p
    WHERE p."key" <> trim(both '-' from p."key")
      AND trim(both '-' from p."key") <> ''
)
UPDATE "Product" p
SET "key" = c.target
FROM candidate c
WHERE c."id" = p."id"
  AND c.rank = 1
  AND NOT EXISTS (
      SELECT 1
      FROM "Product" other
      WHERE other."workspaceId" = c.workspace_id
        AND other."id" <> c."id"
        AND other."key" = c.target
  );
