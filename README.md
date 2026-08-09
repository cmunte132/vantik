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

The automations subsystem no longer uses trigger.dev. An integration and an
action are two halves of one vendor, and they are now one plugin that the server
loads from `apps/server/src/integrations/<slug>`. The server dispatches the work
on the redis that the stack already needs.

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

The ceilings are three review passes, five dollars and thirty minutes for the
whole attempt. All three, and the switch that turns reviewing off, are in
**Settings → Agents**. The full behaviour is in
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
| Action schedules | per action | (set on the action) | This job runs an action that a person put on a schedule. The server reads the schedules at start and it registers one repeatable job for each. |

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
that changes that directory deploys the documentation to GitHub Pages. See
`.github/workflows/deploy-docs.yml`. The DNS for `vantik.dev` does not point at
GitHub Pages yet. See `apps/docs/static/CNAME` and
[the GitHub guide for a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).
Until then, GitHub builds the documentation and serves it at
`https://cmunte132.github.io/vantik/`.

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
