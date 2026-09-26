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
| `setup` | Waits for the stack. Then it signs up two people, Alice and Bob, each with a workspace of their own, and saves their credentials in `.auth/accounts.json`. |
| `api` | Calls the HTTP API and the MCP endpoint directly, as Alice or as Bob. |

A `browser` project will use the same accounts to sign in to the webapp.

## How to run the tests

Start the stack with the e2e overlay. The overlay adds Mailpit, a mail catcher.
The tests sign in the way a person does: they read the login code from the
email.

```bash
cp .env.example .env
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
push to `main`. It builds both images from the commit and starts the stack with
the default `.env.example`. Then it does these checks:

1. It waits for `GET /health/ready`. The server gives this answer only after it
   has applied the migrations to an empty database and every dependency
   answers.
2. It replays the migration history into a scratch database and compares the
   result with `schema.prisma` (`pnpm --filter server migrate:check`).
3. It runs this suite.

If a check fails, the workflow uploads the Playwright report and the container
logs as the `e2e-report` artifact.

## Known holes

Some tests in `tests/api/tenancy.spec.ts` call `knownHole(...)`. Each one is a
hole in the workspace boundary that is known and not yet closed on `main`.
`knownHole` marks the test as an expected failure, so the suite stays green.
When a change closes the hole, the test passes and Playwright reports "expected
to fail, but passed". Then remove the `knownHole` call from that test.

## How to write a test

- Import `test` and `expect` from `src/fixtures`. The fixtures give you `alice`
  and `bob` (their ids and tokens), `asAlice` and `asBob` (API clients that use
  their tokens), and `anonymous` (a client with no credentials).
- Make the records that the test needs. `src/api.ts` has small builders for
  them. Do not rely on records from other tests. The tests run in parallel.
- Do not change shared records. For example, do not rename Alice's team or her
  "Todo" state. If a test must change or delete a team, make a spare team with
  `createSpareTeam`.
- Assert on what the product does, not on how it does it. A good assertion is
  "Alice's issue still has its title". A poor assertion is "the handler called
  the service".
