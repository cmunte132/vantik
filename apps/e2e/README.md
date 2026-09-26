# End-to-end tests

These tests drive a running Vantik stack from the outside, the way a person or
an agent does. The unit suites mock the database, redis, the auth core and the
mail server. These tests mock nothing. They find the problems that only a
running stack shows: a server that does not start, a route that serves another
workspace's records, a feature that works in the code and not in the image.

The runner is [Playwright](https://playwright.dev). Today the suite has two
projects:

| Project | What it does |
| --- | --- |
| `setup` | Waits for the stack. Then it provisions three people and saves their credentials in `.auth/accounts.json`. |
| `api` | Calls the HTTP API, the sync API and the MCP endpoint directly, as any of the three. |

The three people:

| Person | Workspace | Team |
| --- | --- | --- |
| Alice | her own | ALC, and CRL |
| Bob | his own | BOB |
| Carol | Alice's. Alice invites her, and she accepts. | CRL only |

Bob is the outsider for the workspace boundary. Carol is the insider for the
team boundary: she is in Alice's workspace, but not in Alice's team.

A `browser` project will use the same accounts to sign in to the webapp. See
[Next: browser tests](#next-browser-tests).

## How to run the tests

Start the stack with the e2e overlay. The overlay adds Mailpit, a mail catcher.
The tests sign in the way a person does: they read the login code from the
email.

```bash
cp .env.example .env
echo "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
docker compose -f docker-compose.yaml -f docker-compose.e2e.yaml up -d --build --wait
pnpm install
pnpm e2e
```

The tests also work against `pnpm dev`. Start Mailpit beside the other service
containers, and point the server at it in `.env`:

```bash
docker compose -f docker-compose.yaml -f docker-compose.e2e.yaml up -d postgres redis supertokens typesense mailpit
cat >> .env <<'EOF'
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=e2e
SMTP_PASSWORD=e2e
SMTP_DEFAULT_FROM="Vantik <noreply@vantik.test>"
EOF
pnpm dev
pnpm e2e
```

Each run makes new accounts and new workspaces, so you do not need to reset the
database between runs.

To see the results of the last run, including a trace of each failed test:

```bash
pnpm --filter @vantikhq/e2e e2e:report
```

Mailpit's inbox is at http://localhost:8025.

### Settings

| Variable | Default |
| --- | --- |
| `E2E_SERVER_URL` | `http://localhost:3001` |
| `E2E_WEBAPP_URL` | `http://localhost:3000` |
| `E2E_MAILPIT_URL` | `http://localhost:8025` |

## In CI

`.github/workflows/e2e.yml` runs on every pull request to `main` and on every
push to `main`. It builds both images from the commit and starts the stack the
way `README.md` says to: the defaults from `.env.example`, plus a new
`CREDENTIAL_ENCRYPTION_KEY`. Then it does these checks:

1. It waits for `GET /health/ready`. The server gives this answer only after it
   has applied the migrations to an empty database and every dependency
   answers.
2. It replays the migration history into a scratch database and compares the
   result with `schema.prisma` (`pnpm --filter server migrate:check`).
3. It runs this suite.

If a check fails, the workflow uploads the Playwright report and the container
logs as the `e2e-report` artifact.

## Known bugs

Some tests call `knownBug(...)`. Each one tests a bug that is known and not yet
fixed on `main`, and the argument says what the bug is. `knownBug` marks the
test as an expected failure, so the suite stays green. When a change fixes the
bug, the test passes and Playwright reports "expected to fail, but passed".
Then remove the `knownBug` call from that test.

To see which bugs are open:

```bash
grep -rn "knownBug(" apps/e2e/tests
```

Call `knownBug` after the test's setup, and check that setup first. An
expected failure passes whatever makes it fail. If the setup breaks before the
call, the test fails as it should. If the setup breaks after the call, the
suite reports that the bug is still there.

The webapp's unit tests do the same with Vitest's `it.fails`.

## How to write a test

- Import `test` and `expect` from `src/fixtures`. The fixtures give you `alice`
  and `bob` (their ids and tokens), `asAlice` and `asBob` (API clients that use
  their tokens), and `anonymous` (a client with no credentials).
- The fixtures also give you `carol` and `asCarol`, Alice's teammate in the
  CRL team only.
- Make the records that the test needs. `src/api.ts` has small builders for
  them. Do not rely on records from other tests. The tests run in parallel.
- To check what the webapp is sent, use `src/sync.ts`. The webapp reads its
  records from the sync API, not from the REST routes. A write reaches the sync
  log a moment after the request returns, through Postgres replication. So take
  a `cursor` before the write, and wait for the change with `synced`.
- Before you assert that someone was not sent a record, wait until someone who
  should get it has it. Otherwise "not replicated yet" also passes the test.
- Do not change shared records. For example, do not rename Alice's team or her
  "Todo" state. If a test must change or delete a team, make a spare team with
  `createSpareTeam`.
- Assert on what the product does, not on how it does it. A good assertion is
  "Alice's issue still has its title". A poor assertion is "the handler called
  the service".

## Next: browser tests

The API tests prove what the server does. They cannot see what the webapp does
with it. These bugs need a real browser to find:

- a page that crashes or does not hydrate with real data;
- sign-in through the webapp's proxy, with cookies;
- the socket that carries live updates to a second person's screen;
- the local database after a reload, after a schema upgrade, or offline;
- the production build of the webapp.

The plan is a `browser` project in `playwright.config.ts`. It depends on
`setup` and uses the same people. It will have two parts:

1. **A crawl.** One test signs in as Alice, opens each main page, and fails on
   any page error, console error, or failed request.
2. **A few journeys.** For example: Alice creates an issue and sees it in the
   list. Carol sees Alice's change on her screen without a reload. An issue is
   still there after a reload. An edit made offline is sent when the browser is
   back online.

CI already builds and starts the webapp for this job, so the project adds only
Chromium and the test time.
