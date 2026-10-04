# End-to-end tests

These tests use a real Vantik stack, as a person or an agent does.
The unit suites use test objects for the database, Redis, and the SMTP server.
These tests use real services. They check server startup, workspace access, and the behavior of the application.

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
docker compose -f docker-compose.yaml -f docker-compose.e2e.yaml up -d postgres redis mailpit
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
Mailpit stores the test messages. It does not send them to the external inbox of the recipient.

### Settings

| Variable | Default |
| --- | --- |
| `E2E_SERVER_URL` | `http://localhost:3001` |
| `E2E_WEBAPP_URL` | `http://localhost:3000` |
| `E2E_MAILPIT_URL` | `http://localhost:8025` |
| `E2E_DATABASE_URL` | `postgresql://docker:docker@localhost:5432/vantik` |
| `E2E_RUN_TAG` | A new random value for each run |

`E2E_RUN_TAG` goes into the names of the workspaces that a run makes. A
workspace slug must be unique on the server, so each run needs a new tag. Set
it only to find the records of one run again.

If the test stack uses separate ports, set `FRONTEND_HOST`, `BACKEND_HOST`, and
`NEXT_PUBLIC_BACKEND_HOST` on the test server. Set `BACKEND_URL` on the webapp.
Set `PUBLIC_ATTACHMENT_URL` to the frontend address with the `/api` suffix.
Leave the `LLM_*` settings empty if the test stack has no AI provider.

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

   `migrate:check` needs `SHADOW_DATABASE_URL`, the address of an empty
   database for the replay. To run it on your machine, make that database
   first:

   ```bash
   docker exec vantik-postgres createdb -U docker vantik_shadow
   docker exec vantik-postgres psql -U docker -d vantik_shadow -c 'CREATE SCHEMA IF NOT EXISTS vantik'
   SHADOW_DATABASE_URL='postgresql://docker:docker@localhost:5432/vantik_shadow?schema=vantik' pnpm --filter server migrate:check
   ```
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

## Docs screenshots

The screenshots on the docs site come from this package, not from someone's
workspace. `screenshots/docs.setup.ts` signs up Ada Lovelace, adds two
teammates, and seeds a small web shop through the API (`screenshots/seed.ts`):
a cycle, a project with milestones, a product with modules and a capability,
two teams, issue templates, a dozen issues, a view, a knowledge page, and the
comments and assignments that fill Ada's inbox. A few records have no endpoint
because only a real executor makes them, so `screenshots/seed-agents.ts`
writes them straight into the database (`screenshots/db.ts`): agent runs in
each state the docs show (working, handed back, rejected, failed) with their
activity, a model key and the repository the runs work in. Replication carries
those rows to the webapp like any other write.
`screenshots/app.capture.ts` then opens one page for each screenshot and saves
it under `apps/docs/static/img/docs/<section>/<name>.png`.

Every release retakes them. Once the release's images are published,
`.github/workflows/docs-screenshots.yml` boots the stack from them, runs the
capture from the release tag, commits the screenshots that changed to main,
and deploys the docs. A UI change therefore reaches the docs with the release
that ships it, and nobody takes a screenshot by hand. To retake them for a
release again, run that workflow from the Actions tab with its version.

To run the capture locally, start the same stack as the tests, Mailpit
included, with `docker-compose.docs.yaml` on top: it adds a stand-in sandbox
host so the server offers the delegate control, and it starts nothing. Point
`E2E_DATABASE_URL` at the stack's Postgres if it is not on localhost:5432.

```bash
pnpm --filter @vantikhq/e2e screenshots
```

```bash
pnpm --filter @vantikhq/e2e screenshots:check
```

The first writes every screenshot. The second compares them with the committed
ones and fails on any that changed, with a diff in the report
(`screenshots-report/`). You do not need either for a UI change, which the
next release captures. Run them when you add or change a capture, and commit
the new image with the docs page that shows it, so the page has its image
before the release retakes it.

Each run seeds a new workspace and renames it to "Acme", so issue numbers,
names and titles come out the same every time. The browser clock is fixed to
the next whole hour, and the per-run email addresses are shown as
`ada@acme.dev`. Dates such as a project's target date are relative to the day
of the run, so the few screenshots that show one change with every release,
and a check run on a later day than the capture reports them.

A screenshot shows the feature its page is about, not the whole window.
`shot(page, name, { focus, padding, highlight })` in `screenshots/frame.ts`
crops to the box around the `focus` locators (plus `padding`, 24px by default)
and draws a ring in the primary colour around each `highlight` locator, such as
the button that opened a popover. A whole page is `focus: content(page)` with
no padding; a settings section is `focus: section(page, '<heading>')`.

To add a screenshot, seed what it needs in `seed.ts`, add a test to
`app.capture.ts` that opens the page and calls `shot()` with what to focus on,
and reference it from the docs as `/img/docs/<section>/<name>.png`.
