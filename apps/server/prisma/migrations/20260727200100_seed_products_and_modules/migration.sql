-- Fills in the product axis for the workspaces that exist now, so that no
-- workspace changes behaviour when the axis arrives.
--
-- Three steps. Each workspace gets one product, named after the workspace. Each
-- repository that a team already claims becomes one module under that product,
-- and the team goes in linkedTeamIds. Then each issue of a team that claimed
-- exactly one repository gets that module.
--
-- The third step is deliberately narrow. If a team claimed two repositories, no
-- rule says which one an old issue belongs to. An empty list is honest, and a
-- person or a pull request fills it in later. A guess would look like data.

-- Step one. One product for each workspace.
--
-- The workspace slug becomes the product key. A slug is already short, already
-- lowercase, and already unique in its workspace, which is everything the key
-- has to be.
INSERT INTO "Product" ("id", "createdAt", "updatedAt", "name", "key", "description", "status", "workspaceId")
SELECT
    gen_random_uuid()::text,
    now(),
    now(),
    w."name",
    w."slug",
    'Added when this workspace got the product axis. Rename it, or move its modules to a product of your own.',
    'active',
    w."id"
FROM "Workspace" w
WHERE w."deleted" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."workspaceId" = w."id");

-- Step two. One module for each repository that a team claims.
--
-- Two shapes for the same list have existed in this repository: the server wrote
-- `mappings` with `id`, and the client type declared `repositoryMappings` with
-- `githubRepoId`. This reads both, because a workspace can hold either.
--
-- The product owns each module, and the team that claimed the repository goes in
-- linkedTeamIds. Ownership by the product is what lets several teams work in one
-- repository. The link keeps the team that was there before.
WITH mapping AS (
    SELECT
        ia."workspaceId" AS workspace_id,
        m->>'teamId' AS team_id,
        COALESCE(m->>'githubRepoId', m->>'id') AS repo_id,
        COALESCE(
            m->>'githubRepoFullName',
            (
                SELECT r->>'fullName'
                FROM jsonb_array_elements(ia."settings"->'repositories') r
                WHERE r->>'id' = COALESCE(m->>'githubRepoId', m->>'id')
                LIMIT 1
            )
        ) AS full_name
    FROM "IntegrationAccount" ia
    CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(
            CASE WHEN jsonb_typeof(ia."settings"->'repositoryMappings') = 'array'
                 THEN ia."settings"->'repositoryMappings' END,
            CASE WHEN jsonb_typeof(ia."settings"->'mappings') = 'array'
                 THEN ia."settings"->'mappings' END,
            '[]'::jsonb
        )
    ) m
    WHERE ia."deleted" IS NULL
),
named AS (
    SELECT
        workspace_id,
        team_id,
        COALESCE(full_name, 'repo-' || repo_id) AS name,
        -- The key is the repository name without the owner, in lower case, with
        -- every other character turned into a dash. split_part returns an empty
        -- string and not null when the name has no owner, so NULLIF is what lets
        -- COALESCE reach the next choice.
        lower(regexp_replace(
            COALESCE(
                NULLIF(split_part(COALESCE(full_name, ''), '/', 2), ''),
                full_name,
                'repo-' || repo_id
            ),
            '[^a-zA-Z0-9]+', '-', 'g'
        )) AS key
    FROM mapping
    WHERE team_id IS NOT NULL
),
-- One row for each key. If two teams claim the same repository, one module gets
-- both teams in the next statement.
unique_module AS (
    SELECT DISTINCT ON (workspace_id, key)
        workspace_id, key, name
    FROM named
    WHERE key <> ''
    ORDER BY workspace_id, key, name
),
-- One product for each workspace, chosen the same way every time. A workspace
-- can already hold more than one product if somebody made one by hand, and a
-- plain join would then write the module once for each of them.
owner_product AS (
    SELECT DISTINCT ON ("workspaceId")
        "workspaceId" AS workspace_id, "id" AS product_id
    FROM "Product"
    WHERE "deleted" IS NULL
    ORDER BY "workspaceId", "createdAt", "id"
)
INSERT INTO "Module" ("id", "createdAt", "updatedAt", "name", "key", "description", "status", "ownerProductId", "linkedTeamIds", "linkedProductIds", "workspaceId")
SELECT
    gen_random_uuid()::text,
    now(),
    now(),
    u.name,
    u.key,
    'Added from the repository that a team already claimed.',
    'active',
    op.product_id,
    ARRAY(
        SELECT DISTINCT n.team_id
        FROM named n
        WHERE n.workspace_id = u.workspace_id AND n.key = u.key
    ),
    ARRAY[]::text[],
    u.workspace_id
FROM unique_module u
JOIN owner_product op ON op.workspace_id = u.workspace_id
WHERE NOT EXISTS (
    SELECT 1 FROM "Module" m
    WHERE m."workspaceId" = u.workspace_id AND m."key" = u.key
);

-- Step three. Give an issue its module only when the team claimed exactly one
-- repository. Anything else stays empty.
WITH team_module AS (
    SELECT
        t."id" AS team_id,
        min(m."id") AS module_id
    FROM "Team" t
    JOIN "Module" m
      ON m."workspaceId" = t."workspaceId"
     AND t."id" = ANY (m."linkedTeamIds")
    WHERE t."deleted" IS NULL AND m."deleted" IS NULL
    GROUP BY t."id"
    HAVING count(*) = 1
)
UPDATE "Issue" i
SET "moduleIds" = ARRAY[tm.module_id]
FROM team_module tm
WHERE i."teamId" = tm.team_id
  AND coalesce(cardinality(i."moduleIds"), 0) = 0;
