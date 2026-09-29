<br>
<h1 align="center">Vantik</h1>
<h3 align="center">An issue tracker for developers and for agents.</h3>

<p align="center">
You host Vantik yourself, and its source is open. Agents plan, track, and audit
their own work in it. People review that work in a real user interface.
</p>

<br>

## What this is

Vantik is a fork of [Tegon](https://github.com/RedPlanetHQ/tegon). Tegon is an
open-source issue tracker for developers, and an alternative to Jira and Linear.
RedPlanetHQ, the original maintainer, archived it in June 2025.

The original project has a good core data model: projects, issues, workflows,
Kanban views, list views, and triage. But the maintainers built it for human
teams. Such a team uses AI as an assistant. It does not use an agent as the
primary actor.

This fork changes that. In Vantik, an agent creates, plans, and updates work as
its default operation. The user interface is where a person reviews and audits
that work. It is not the primary interface.

**Status:** this fork is early, and it is a personal project. Changes can break
your installation, and some parts still show the old Tegon brand. The code
builds and runs on a local machine. Read [How to start](#how-to-start-self-hosted).
In July 2026 the maintainer updated the dependencies to NestJS 11, Prisma 6,
React 19, Next 16, TanStack Query 5, Tiptap 3, AI SDK 7, and zod 4. The webapp
builds with Turbopack. The webapp reads the `NEXT_PUBLIC_*` settings from the
server at `/api/v1/config`, so a self-hosted installation sets them when the
container starts. One update is not complete: the ESLint 9 flat config.

The automations subsystem no longer uses trigger.dev, and Actions are gone. An
integration is one plugin that the server loads from
`apps/server/src/integrations/<slug>`. Connecting it is the whole configuration:
it then reacts to the record changes and webhooks it declares, and the server
dispatches that work on the redis that the stack already needs.

## Attribution and license

Vantik is a derivative work of
[RedPlanetHQ/tegon](https://github.com/RedPlanetHQ/tegon), and the
[AGPL-3.0](./LICENSE) license applies to it. The Tegon team gets all the credit
for the original architecture, the data model, and the implementation. The
maintainer of this fork works independently. RedPlanetHQ and Tegon do not
control this fork, and they do not endorse it.

## How to start (self-hosted)

You need Docker, or podman with the compose provider. The compose stack needs no
other setup. It runs the webapp, the API server, and all the services:
postgres, redis, SuperTokens, and Typesense. The server applies the database
migrations when it starts.

```bash
cp .env.example .env   # the default values work; change the secrets for a real deployment
echo "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env   # the one secret with no default
docker compose up -d
```

Open http://localhost:3000. Then sign in with any email address. If you
configure no SMTP server, the server writes the magic login link to its log and
sends no email:

```bash
docker compose logs server | grep -A5 "magic link"
```

For a deployment that is not on localhost, do these two steps:

1. Set `FRONTEND_HOST` and `BACKEND_HOST` in `.env` to your domain.
2. Change `POSTGRES_PASSWORD` and `TYPESENSE_API_KEY`.

### How to connect your own agent

**Settings → Agents** makes a token for an agent, and gives the MCP
configuration for Claude Code, Codex, Cursor, and other clients. Three
[agent skills](./skills/README.md) then teach the agent to use the tracker, the
knowledge bank, and delegation well. Install them from your server, which gives
the copy that matches it:

```bash
DISABLE_TELEMETRY=1 npx skills add https://your-vantik-host
```

Or install them from this repository with `npx skills add cmunte132/vantik`.

The same page gives optional hooks for each agent. At the start of a session,
they tell the agent which issues it has in progress. Before the agent stops, they
hold it once if one of those issues has had no update from it for 20 minutes.
Read [How to connect an MCP client](apps/docs/docs/api-reference/connect-mcp.mdx)
for the details.

### How agent work gets checked

Delegate an issue to an agent in the hosted sandbox and the work goes round a
loop before anybody sees a pull request. One agent implements the change.
Vantik runs the repository's own test, typecheck, lint and build commands
against the tree it left. A *second* agent — a fresh process, in the same
sandbox, with different instructions and no sight of the first one's reasoning —
reads the diff against the issue and reports what is missing, citing a file and
a line for each thing. Those go back to be fixed, and it reads the result again.

That repeats until the reviewer accepts the work or the issue's budget runs out.
A run that runs out still delivers its branch; it finishes as **Needs review**
rather than as a success, and the pull request says that nothing signed it off.

The ceilings are three review passes and five dollars for the whole attempt.
Both, and the switch that turns reviewing off, are in **Settings → Agents**.
The wall-clock limit (thirty minutes by default) applies per run and is not
currently configurable in the settings screen. The full behaviour is in
[the review cycle documentation](./apps/docs/docs/agents/review-cycle.mdx).

### Scheduled work

Vantik does some of its work on a schedule, and not in response to a request.
The server process runs this work as Bull repeatable jobs, on the redis that the
stack already needs. No necessary work can depend on an optional service. The
server registers each job when it starts, and it writes the schedule to the log.
To see if a job runs, read `docker compose logs server`.

| Job | Default | Variable | What it does |
| --- | --- | --- | --- |
| Cycle maintenance | hourly | `CYCLE_MAINTENANCE_CRON` | This job applies to a team with the automatic cadence. It completes each cycle after the end date of that cycle. It then moves the unfinished issues, as the preference of the team tells it to, and it makes more future cycles. The job never changes a team that controls its cycles manually. |
| Knowledge decay | `0 3 * * *` | `PAGE_DECAY_CRON` | This job archives each knowledge entry that no person triaged and that the server never served. |
| Knowledge gap issues | `0 4 * * 1` | `KNOWLEDGE_GAP_ISSUES_CRON` | This job opens one issue for each question that agents asked the knowledge often and that it could not answer. It opens the issue on the team that owns the module of the question. It never opens a second issue for the same question. |

To stop a job, set its variable to `off`.

These services are optional. If one is absent, the server writes an error to the
log and continues:

- **an LLM endpoint** runs the AI features. Any endpoint with the OpenAI
  interface works: OpenRouter, OpenAI, or a local LM Studio, Ollama, or vLLM
  server. Set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL_FAST`, and
  `LLM_MODEL_SMART`. If you do not set them, the webapp hides all the AI
  controls, and the other features work as normal. If you set them later, the
  controls appear on the next page load.
- **SMTP** sends real email. Set the `SMTP_*` variables.

## Local development

You need Node.js 20 or later, pnpm 10, and Docker or podman. To install pnpm,
run `npm i -g pnpm@10`.

For hot reload, run only the service containers, and run the apps on the host.
These containers publish their ports on localhost for this purpose.

```bash
cp .env.example .env
echo "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env

# 1. The service containers only. This command starts no webapp and no server.
docker compose up -d postgres redis supertokens typesense

# 2. The npm packages and the database schema
pnpm install
pnpm migrate

# 3. The server on port 3001 and the webapp on port 3000, with hot reload
pnpm dev
```

If the full stack already runs in containers, the app ports are in use. To free
them, run `docker compose stop webapp server`.

### Tests

```bash
pnpm typecheck
pnpm test   # the unit tests. They need no services.
pnpm e2e    # the end-to-end tests. They need a running stack.
```

The unit tests include the webapp's sync tests
(`apps/webapp/src/store/sync-contract.spec.ts`). They run every synced model
through the real save handlers, into a real IndexedDB and the real store, and
check that nothing the server sends is lost on the way.

The end-to-end tests drive a running stack from the outside, with the
`docker-compose.e2e.yaml` overlay. CI runs them on every pull request. To set
them up, read [apps/e2e/README.md](apps/e2e/README.md).

### Local repositories

A git repository on your disk can be a source of code, the same as a GitHub
repository. The server uses it as a git remote: it fetches the repository into
its own copy (under `REPO_MIRROR_ROOT`), and reads code, checks citations, and
starts agent runs from that copy. When an agent run finishes, the server pushes
its branch back into your repository, for example `agent/eng-42`. The server
never reads or changes your working tree or the branch you have checked out.

Set the directory that holds your checkouts, then start the stack as usual:

```bash
echo 'LOCAL_REPO_ROOT=/Users/you/Code' >> .env
docker compose up -d
```

`docker-compose.yaml` mounts `LOCAL_REPO_ROOT` read-write at the same path in
the container, so a path that works on your machine works in the server. A
repository must be inside that directory. Do not set it to your home directory,
because the server can then reach every file in it.

### Hosted agent runs

An agent run works in a microVM. The server does not start these VMs. A
separate process, the sandbox host (`apps/sandbox-host`), starts them, and the
server calls it over HTTP. The sandbox host must run where QEMU and hardware
virtualisation are. On macOS, no container has hardware virtualisation, so the
sandbox host runs natively there, next to the containers.

Both need the same token:

```bash
echo "SANDBOX_HOST_TOKEN=$(openssl rand -hex 32)" >> .env
```

**macOS.** Install QEMU, then start the sandbox host in a terminal and keep it
open. It needs Node 23.6 or later.

```bash
brew install qemu
```

```bash
pnpm sandbox-host
```

It listens on `127.0.0.1:3004`. The server container reaches it at
`host.docker.internal:3004`, which is the default in `docker-compose.yaml`. If
you run the server with `pnpm dev`, add `SANDBOX_HOST_URL=http://127.0.0.1:3004`
to `.env`.

**Linux.** Run the sandbox host as a container, with `/dev/kvm` passed through:

```bash
echo "SANDBOX_HOST_CONTAINER_URL=http://sandbox-host:3004" >> .env
```

```bash
docker compose --profile sandbox up -d
```

The first sandbox downloads the guest image into the `sandbox-images` volume,
so the first run takes longer.

The sandbox host stops a sandbox at the run's time limit, and disposes of a
sandbox that gets no request from the server for five minutes, for example
after the server stops. When the server starts, it disposes of the sandboxes of
runs that have ended. When the server cannot reach a sandbox host, agent runs
are refused, and the Agents page says why.

### Observability

The server has OpenTelemetry instrumentation, but it exports no data until you
give it an endpoint. To get the metrics and the traces in a local Grafana with a
dashboard, add the observability overlay:

```bash
docker compose -f docker-compose.yaml -f docker-compose.observability.yaml up -d
```

Grafana is on [localhost:3002](http://localhost:3002) and needs no login. The
overlay includes Prometheus, Tempo, and Loki. These all work with no more setup:
the rate, the errors, and the latency of the requests, the health of the Node
event loop and of the heap, the request traces, and the logs. Every log line
holds its `traceId`, so you can go from a slow trace to the log lines of that
trace, and back again. The logs use the same OTLP connection as the other data.
No service reads your containers directly.

The overlay also starts Bull Board on [localhost:3003](http://localhost:3003).
It shows the background jobs of the server for each queue, and the error of
each failed job. Bull deletes most jobs when they complete, so the dashboard
does not show a job after it completes.

If you run the apps on the host, start the observability stack together with the
service containers. Then set the exporter to the published port, and not to the
container:

```bash
docker compose -f docker-compose.yaml -f docker-compose.observability.yaml up -d postgres redis supertokens typesense lgtm
echo 'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318' >> .env
```

To read what the server collects, and what the maintainer left out, see
[Observability](apps/docs/docs/oss/self-deployment.mdx).

## Documentation

The documentation is in `apps/docs`, and it uses Docusaurus. A push to `main`
that changes that directory deploys the documentation to GitHub Pages at
`https://docs.vantik.dev`. See `.github/workflows/deploy-docs.yml`. The workflow
deploys with GitHub Actions, so GitHub ignores `apps/docs/static/CNAME`. The
custom domain is a setting in the repository: Settings, then Pages.

The marketing site is in `apps/landing`, and it uses Astro. A Cloudflare Worker
serves its build output at `https://vantik.dev`. See `apps/landing/wrangler.jsonc`. The file
`apps/landing/public/_redirects` sends the old `vantik.dev/docs/...` addresses
to the documentation site.

To work on the documentation on your machine, run these commands:

```bash
cd apps/docs
pnpm install
pnpm run gen-api-docs vantik   # make the API reference again from openapi/openapi.yml
pnpm start                     # the local dev server, with hot reload
```

The repository needs one more setup step, and you do it one time only. In the
GitHub repository, open Settings, then Pages. Set the source to "GitHub Actions"
and not to "Deploy from a branch". The workflow above needs this setting.

To work on the marketing site on your machine, run this command from the root
of the repository:

```bash
pnpm --filter landing dev      # http://localhost:4321
```

## Roadmap (the plan, not yet built)

- [ ] Make the stack build and run self-hosted in this fork
- [ ] An MCP server. An agent uses it to create, read, update, and delete an
      issue or a project.
- [ ] Design the automation framework again. Its original name is "Tegon
      Actions". The new design must put the agent first, because today a person
      starts each automation.
- [ ] Navigation across many repositories and many projects, for one person who
      reviews several codebases that agents control

Done:
- [x] Change the brand from Tegon. Remove the Slack integration and the Cloud
      marketing content.
- [x] Move the documentation from Mintlify to a self-hosted Docusaurus site on
      GitHub Pages. This site replaces the old `apps/website` marketing app.

## How to contribute

This is a personal project now. The maintainer can look at an issue or a pull
request, but there is no formal process yet.
