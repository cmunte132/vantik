import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from 'pg';

/**
 * The migration that gives an existing workspace its product axis.
 *
 * ENG-73 asks for one thing above all: a workspace that upgrades must behave
 * afterwards exactly as it did before. The migration cannot be tested by
 * reading it, because what it does depends on data that only an old workspace
 * has — repository mappings written in two different shapes by two different
 * versions of the server, teams that claim no repository, and teams that claim
 * several.
 *
 * So this builds one. It applies the whole migration history to an empty
 * database, seeds a workspace shaped like one from before the axis existed,
 * runs the seed migration against it, and reads the result back.
 *
 * This test needs postgres. It reads DATABASE_URL for the host, and then creates
 * and drops a database of its own beside the one that URL names — it never
 * writes to it. Without that variable there is nothing to connect to and the
 * whole file is skipped, so run it with the repository's env loaded:
 *
 *     pnpm dotenv -- pnpm --filter server test product-axis-migration
 */

const execFileAsync = promisify(execFile);

const DATABASE_URL = process.env.DATABASE_URL;

// A skipped suite is honest about needing a database. A suite that passed
// without one would not be.
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const SERVER_ROOT = join(__dirname, '..', '..', '..');
const PRISMA = join(SERVER_ROOT, 'node_modules', '.bin', 'prisma');
const SEED_MIGRATION = join(
  SERVER_ROOT,
  'prisma',
  'migrations',
  '20260727200100_seed_products_and_modules',
  'migration.sql',
);

/** The schema every table lives in, and what the migration's SQL assumes. */
const SCHEMA = 'vantik';

/**
 * The description the migration writes on every module it makes. The seed below
 * also writes a module by hand, the way a person would have, and the two have
 * to be told apart: the point of several assertions is that the migration left
 * the hand-written one alone.
 */
const MADE_BY_THE_MIGRATION = `m."description" = 'Added from the repository that a team already claimed.'`;

const scratchName = `vantik_axis_test_${randomUUID().replace(/-/g, '')}`;

/**
 * Only these modes mean the connection must be encrypted. Prisma reads
 * `sslmode=prefer` as "encrypt if the server offers it", which is what the
 * repository's own URL says; pg reads any sslmode at all as "require", and
 * then fails against a local postgres that serves no certificate.
 */
const SSL_IS_REQUIRED = /sslmode=(require|verify-ca|verify-full)/.test(
  DATABASE_URL ?? '',
);

function urlForDatabase(name: string) {
  const url = new URL(DATABASE_URL as string);
  url.pathname = `/${name}`;

  return url;
}

/** Connects to a database by name, with the search path already set. */
async function connectTo(name: string, withSearchPath = true) {
  const url = urlForDatabase(name);

  // pg reads the connection string after it reads the options object, so an
  // `ssl: false` beside it loses. Taking the parameter out of the string is
  // what actually turns encryption off.
  if (!SSL_IS_REQUIRED) {
    url.searchParams.delete('sslmode');
  }

  const client = new Client({ connectionString: url.href });
  await client.connect();

  if (withSearchPath) {
    // The migration's SQL names its tables unqualified. Prisma sets the search
    // path from the URL's schema parameter; a plain pg client does not.
    await client.query(`SET search_path TO "${SCHEMA}"`);
  }

  return client;
}

describeWithDatabase(
  'the seed migration, on a workspace from before the axis',
  () => {
    let db: Client;

    beforeAll(async () => {
      const admin = await connectTo('postgres', false);
      try {
        await admin.query(`CREATE DATABASE "${scratchName}"`);
      } finally {
        await admin.end();
      }

      // The real history, not a hand-written copy of the tables it produces. A
      // copy would keep passing after the schema moved underneath it.
      //
      // The binary directly rather than through npx: npx is a second process
      // around the first, and jest has to wait for both to be reaped before the
      // worker can exit.
      await execFileAsync(PRISMA, ['migrate', 'deploy'], {
        cwd: SERVER_ROOT,
        env: { ...process.env, DATABASE_URL: urlForDatabase(scratchName).href },
      });

      db = await connectTo(scratchName);
      await seedWorkspacesFromBeforeTheAxis(db);

      // Everything above is the old workspace. This is the migration under test,
      // run a second time on data that did not exist when the history ran.
      await db.query(readFileSync(SEED_MIGRATION, 'utf8'));
    }, 120_000);

    afterAll(async () => {
      await db?.end();

      const admin = await connectTo('postgres', false);
      try {
        await admin.query(
          `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`,
        );
      } finally {
        await admin.end();
      }
    }, 30_000);

    describe('one product for each workspace', () => {
      it('names the product after the workspace and keys it by the slug', async () => {
        const { rows } = await db.query(
          `SELECT w."slug", p."name", p."key", p."status"
         FROM "Product" p JOIN "Workspace" w ON w."id" = p."workspaceId"
         ORDER BY w."slug"`,
        );

        expect(rows).toEqual([
          { slug: 'acme', name: 'Acme', key: 'acme', status: 'active' },
          { slug: 'globex', name: 'Globex', key: 'globex', status: 'active' },
        ]);
      });

      it('makes exactly one, however many repositories the workspace had', async () => {
        const { rows } = await db.query(
          `SELECT w."slug", count(p."id")::int AS products
         FROM "Workspace" w LEFT JOIN "Product" p ON p."workspaceId" = w."id"
         GROUP BY w."slug" ORDER BY w."slug"`,
        );

        expect(rows).toEqual([
          { slug: 'acme', products: 1 },
          { slug: 'globex', products: 1 },
        ]);
      });
    });

    describe('one module for each repository a team claimed', () => {
      it('makes a module for every distinct repository, and no more', async () => {
        const { rows } = await db.query(
          `SELECT w."slug", m."key", m."name"
         FROM "Module" m JOIN "Workspace" w ON w."id" = m."workspaceId"
         WHERE ${MADE_BY_THE_MIGRATION}
         ORDER BY w."slug", m."key"`,
        );

        expect(rows).toEqual([
          { slug: 'acme', key: 'infra', name: 'acme/infra' },
          { slug: 'acme', key: 'server', name: 'acme/server' },
          { slug: 'acme', key: 'tools', name: 'acme/tools' },
          { slug: 'globex', key: 'api', name: 'globex/api' },
        ]);
      });

      /**
       * Two teams working in one repository is the case the axis exists for. It
       * must become one module that both teams link, and not two modules with
       * the same key.
       */
      it('makes one module when two teams claim the same repository, linking both', async () => {
        const { rows } = await db.query(
          `SELECT m."linkedTeamIds" FROM "Module" m
         WHERE m."key" = 'server' AND ${MADE_BY_THE_MIGRATION}`,
        );

        expect(rows).toHaveLength(1);

        const { rows: teams } = await db.query(
          `SELECT t."identifier" FROM "Team" t
         WHERE t."id" = ANY($1::text[]) ORDER BY t."identifier"`,
          [rows[0].linkedTeamIds],
        );

        expect(teams.map((team) => team.identifier)).toEqual(['ENG', 'QA']);
      });

      /**
       * The older server wrote `mappings` with an `id`, and the client type
       * declared `repositoryMappings` with a `githubRepoId`. A workspace can hold
       * either, so the migration reads both. The older shape carries no name, and
       * the name has to come from `settings.repositories`.
       */
      it('reads the older mappings shape and resolves its name', async () => {
        const { rows } = await db.query(
          `SELECT m."name", m."key" FROM "Module" m
         JOIN "Workspace" w ON w."id" = m."workspaceId"
         WHERE w."slug" = 'globex' AND ${MADE_BY_THE_MIGRATION}`,
        );

        expect(rows).toEqual([{ name: 'globex/api', key: 'api' }]);
      });

      /**
       * The product owns the module and the team only links it. That is what
       * lets several teams work in one repository, and it is the shape the rest
       * of the axis reads.
       */
      it('gives every module it makes to the product and to no team', async () => {
        const { rows } = await db.query(
          `SELECT count(*)::int AS wrong FROM "Module" m
         WHERE ${MADE_BY_THE_MIGRATION}
           AND (m."ownerProductId" IS NULL OR m."ownerTeamId" IS NOT NULL)`,
        );

        expect(rows[0].wrong).toBe(0);
      });

      it('leaves a module a person owned by hand owned by that team', async () => {
        const { rows } = await db.query(
          `SELECT m."ownerTeamId" IS NOT NULL AS team_owned,
                m."ownerProductId" IS NULL AS no_product
         FROM "Module" m WHERE m."key" = 'hand-set'`,
        );

        expect(rows).toEqual([{ team_owned: true, no_product: true }]);
      });

      it('keeps each workspace to its own modules', async () => {
        const { rows } = await db.query(
          `SELECT count(*)::int AS crossed FROM "Module" m
         JOIN "Product" p ON p."id" = m."ownerProductId"
         WHERE p."workspaceId" <> m."workspaceId"`,
        );

        expect(rows[0].crossed).toBe(0);
      });
    });

    describe('an issue only gets a module that follows from its team', () => {
      /** The issue's module keys, by the title the seed gave the issue. */
      async function modulesByIssue() {
        const { rows } = await db.query(
          `SELECT i."title", coalesce(
                  (SELECT array_agg(m."key" ORDER BY m."key")
                   FROM "Module" m WHERE m."id" = ANY (i."moduleIds")),
                  ARRAY[]::text[]
                ) AS keys
         FROM "Issue" i ORDER BY i."title"`,
        );

        return Object.fromEntries(rows.map((row) => [row.title, row.keys]));
      }

      it('gives the one module to an issue of a team that claimed one repository', async () => {
        expect((await modulesByIssue())['ENG issue']).toEqual(['server']);
      });

      it('gives the same module to the other team that claimed that repository', async () => {
        expect((await modulesByIssue())['QA issue']).toEqual(['server']);
      });

      /**
       * The criterion this file exists for. OPS claimed two repositories, so no
       * rule says which one an old issue belongs to. An empty list is honest; a
       * guess would look like data a person had entered.
       */
      it('gives nothing to an issue of a team that claimed two repositories', async () => {
        expect((await modulesByIssue())['OPS issue']).toEqual([]);
      });

      it('gives nothing to an issue of a team that claimed no repository', async () => {
        expect((await modulesByIssue())['DOC issue']).toEqual([]);
      });

      it('leaves a module that was already on the issue alone', async () => {
        expect((await modulesByIssue())['ENG issue with a module']).toEqual([
          'hand-set',
        ]);
      });
    });

    /**
     * The schema cannot say "exactly one owner", so the migration adds a check
     * constraint by hand. If it were missing, every assertion above would still
     * pass and the rule would only be an agreement between developers.
     */
    describe('the single-owner rule', () => {
      it('refuses a module with two owners', async () => {
        await expect(insertModuleWithOwners(db, true, true)).rejects.toThrow(
          /Module_single_owner/,
        );
      });

      it('refuses a module with no owner', async () => {
        await expect(insertModuleWithOwners(db, false, false)).rejects.toThrow(
          /Module_single_owner/,
        );
      });
    });
  },
);

/**
 * Writes two workspaces as the server wrote them before the axis existed.
 *
 * Acme holds the cases that matter: two teams in one repository, a team in two
 * repositories, and a team in none. Globex holds one team, and writes its
 * mapping in the shape the older server used.
 */
async function seedWorkspacesFromBeforeTheAxis(db: Client) {
  const userId = randomUUID();
  await db.query(
    `INSERT INTO "User" ("id", "updatedAt", "email", "username")
     VALUES ($1, now(), 'migration-test@example.com', 'migration-test')`,
    [userId],
  );

  const definitionId = randomUUID();
  await db.query(
    `INSERT INTO "IntegrationDefinitionV2"
       ("id", "updatedAt", "name", "slug", "description", "icon", "clientId", "clientSecret")
     VALUES ($1, now(), 'Github (migration test)', 'github', 'Github', 'github.svg', '', '')`,
    [definitionId],
  );

  const acme = await insertWorkspace(db, 'Acme', 'acme');
  const eng = await insertTeam(db, acme, 'Engineering', 'ENG');
  const qa = await insertTeam(db, acme, 'Quality', 'QA');
  const ops = await insertTeam(db, acme, 'Operations', 'OPS');
  const doc = await insertTeam(db, acme, 'Docs', 'DOC');

  // The shape the client type declared: `repositoryMappings`, `githubRepoId`,
  // and the full name written beside it.
  await insertIntegrationAccount(
    db,
    acme,
    userId,
    definitionId,
    'acme-github',
    {
      repositoryMappings: [
        { teamId: eng, githubRepoId: '1', githubRepoFullName: 'acme/server' },
        { teamId: qa, githubRepoId: '1', githubRepoFullName: 'acme/server' },
        { teamId: ops, githubRepoId: '2', githubRepoFullName: 'acme/infra' },
        { teamId: ops, githubRepoId: '3', githubRepoFullName: 'acme/tools' },
      ],
    },
  );

  await insertIssue(db, eng, 1, 'ENG issue');
  await insertIssue(db, qa, 1, 'QA issue');
  await insertIssue(db, ops, 1, 'OPS issue');
  await insertIssue(db, doc, 1, 'DOC issue');

  const globex = await insertWorkspace(db, 'Globex', 'globex');
  const gbx = await insertTeam(db, globex, 'Platform', 'GBX');

  // The shape the older server wrote: `mappings`, `id`, and no name at all —
  // the name lives in `repositories` and has to be looked up.
  await insertIntegrationAccount(
    db,
    globex,
    userId,
    definitionId,
    'globex-github',
    {
      mappings: [{ teamId: gbx, id: '10' }],
      repositories: [{ id: '10', fullName: 'globex/api' }],
    },
  );

  await insertIssue(db, gbx, 1, 'GBX issue');

  // A module a team owns because a person made it, written before the
  // migration runs. Its key is one no repository would produce, so it cannot
  // collide with a module the migration makes — a collision would make the
  // migration skip the real one and hide the failure this is testing for.
  const { rows } = await db.query(
    `INSERT INTO "Module"
       ("id", "updatedAt", "name", "key", "description", "status",
        "ownerProductId", "ownerTeamId", "linkedTeamIds", "linkedProductIds", "workspaceId")
     VALUES ($1, now(), 'Set by hand', 'hand-set', 'A person made this one.',
             'active', NULL, $2, ARRAY[]::text[], ARRAY[]::text[], $3)
     RETURNING "id"`,
    [randomUUID(), eng, acme],
  );

  // ENG resolves to `server`. This issue already carries a module, so the
  // migration must leave it as it is.
  await insertIssue(db, eng, 2, 'ENG issue with a module', [rows[0].id]);
}

async function insertWorkspace(db: Client, name: string, slug: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO "Workspace" ("id", "updatedAt", "name", "slug")
     VALUES ($1, now(), $2, $3)`,
    [id, name, slug],
  );

  return id;
}

async function insertTeam(
  db: Client,
  workspaceId: string,
  name: string,
  identifier: string,
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO "Team" ("id", "updatedAt", "name", "identifier", "workspaceId")
     VALUES ($1, now(), $2, $3, $4)`,
    [id, name, identifier, workspaceId],
  );

  return id;
}

async function insertIntegrationAccount(
  db: Client,
  workspaceId: string,
  userId: string,
  definitionId: string,
  accountId: string,
  settings: unknown,
) {
  await db.query(
    `INSERT INTO "IntegrationAccount"
       ("id", "updatedAt", "integrationConfiguration", "accountId", "settings",
        "integratedById", "integrationDefinitionId", "workspaceId")
     VALUES ($1, now(), '{}'::jsonb, $2, $3::jsonb, $4, $5, $6)`,
    [
      randomUUID(),
      accountId,
      JSON.stringify(settings),
      userId,
      definitionId,
      workspaceId,
    ],
  );
}

async function insertIssue(
  db: Client,
  teamId: string,
  number: number,
  title: string,
  moduleIds: string[] = [],
) {
  await db.query(
    `INSERT INTO "Issue"
       ("id", "updatedAt", "title", "number", "teamId", "stateId",
        "moduleIds", "subscriberIds", "labelIds", "attachments")
     VALUES ($1, now(), $2, $3, $4, 'state-1', $5::text[],
             ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[])`,
    [randomUUID(), title, number, teamId, moduleIds],
  );
}

/** Writes a module with the owners the check constraint is meant to refuse. */
async function insertModuleWithOwners(
  db: Client,
  team: boolean,
  product: boolean,
) {
  const { rows: teams } = await db.query(`SELECT "id" FROM "Team" LIMIT 1`);
  const { rows: products } = await db.query(
    `SELECT "id" FROM "Product" LIMIT 1`,
  );

  return db.query(
    `INSERT INTO "Module"
       ("id", "updatedAt", "name", "key", "status", "ownerTeamId", "ownerProductId",
        "linkedTeamIds", "linkedProductIds", "workspaceId")
     VALUES ($1, now(), 'Bad owner', $2, 'active', $3, $4,
             ARRAY[]::text[], ARRAY[]::text[],
             (SELECT "workspaceId" FROM "Team" LIMIT 1))`,
    [
      randomUUID(),
      `bad-owner-${randomUUID().slice(0, 8)}`,
      team ? teams[0].id : null,
      product ? products[0].id : null,
    ],
  );
}
