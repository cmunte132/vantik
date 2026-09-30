# End-to-end tests

These tests drive a running Vantik stack from the outside, the way a person or
an agent does. The unit suites mock the database, redis, the auth core and the
mail server. These tests mock nothing. They find the problems that only a
running stack shows: a server that does not start, a route that serves another
workspace's records, a feature that works in the code and not in the image.

The runner is [Playwright](https://playwright.dev). The suite has four
projects:

| Project | What it does |
| --- | --- |
| `setup` | Waits for the stack. Then it provisions three people and saves their credentials in `.auth/accounts.json`. |
| `api` | Calls the HTTP API, the sync API and the MCP endpoint directly, as any of the three. |
| `browser-setup` | Signs Alice in to the webapp through its sign-in page, with the code from the email, and saves the browser session in `.auth/alice.browser.json`. |
| `browser` | Drives the webapp in Chromium as Alice, and checks what reached the server through the API. |

The three people:

| Person | Workspace | Team |
| --- | --- | --- |
| Alice | her own | ALC, and CRL |
| Bob | his own | BOB |
| Carol | Alice's. Alice invites her, and she accepts. | CRL only |

Bob is the outsider for the workspace boundary. Carol is the insider for the
team boundary: she is in Alice's workspace, but not in Alice's team.

The browser tests sign in as Alice too. See [Browser tests](#browser-tests).

## How to run the tests

Start the stack with the e2e overlay. The overlay adds Mailpit, a mail catcher.
The tests sign in the way a person does: they read the login code from the
email.

```bash
cp .env.example .env
echo "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
docker compose -f docker-compose.yaml -f docker-compose.e2e.yaml up -d --build --wait
pnpm install
pnpm --filter @vantikhq/e2e exec playwright install chromium
pnpm e2e
```

To run one layer, name its project. The setup projects it depends on run
first:

```bash
pnpm e2e --project=api
```

The tests also work against `pnpm dev`. Start Mailpit beside the other service
containers, and point the server at it in `.env`:

```bash
docker compose -f docker-compose.yaml -f docker-compose.e2e.yaml up -d postgres redis supertokens mailpit
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

In a browser test, `page` is already signed in as Alice.

- Make a spare team with `createSpareTeam` and file the test's issues there.
  The list the test opens then holds only what it made, whatever the API
  tests file meanwhile. Alice is added to every team she makes.
- Check the outcome on the server with `asAlice`, not only on the screen. The
  webapp draws a change before the server has it, from its local store, so a
  change the server refused can still look saved.
- Find controls by role and accessible name, as a screen reader does. If a
  control has no name to find it by, give it one in the webapp.
- `src/browser.ts` has helpers to open a team's issues, open an issue, and set
  one of its properties.

## Browser tests

The API tests prove what the server does. The browser tests prove what the
webapp does with it, with the production build, through the webapp's proxy,
and with a cookie session. There are two kinds:

1. **A crawl** (`tests/browser/crawl.spec.ts`). It opens each main page with
   nothing cached, and fails on any page error, console error, or failed or
   refused request. It is what catches a page that a removed module or a bad
   response has quietly broken.
2. **Journeys**. Each one is a thing a person does, checked on the server
   afterwards: create an issue from the keyboard; change its status, priority
   and labels; comment; move a card on the board; save a filter as a view;
   write a page; make a project and a label; search; invite someone, who
   accepts or declines. Several of them came from bugs that only a browser
   shows, such as an edit lost because the sheet closed within the half
   second before it saved, and a socket that silently stopped delivering
   live updates.

The browser project runs one test at a time. Each test works in a team of its
own, so they could run in parallel, but the editors save half a second after
the last keystroke, and a page starved of CPU misses that.

Not yet covered:

- a second person, such as Carol, seeing Alice's change on her screen;
- the local database after a reload, after a schema upgrade, or offline.
