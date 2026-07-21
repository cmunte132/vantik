<br>
<h1 align="center">Vantik</h1>
<h3 align="center">A dev-first, agent-native issue tracker.</h3>

<p align="center">
Self-hosted. Open-source. Built for agents to plan, track, and audit their own work — with a real UI for humans to review it.
</p>

<br>

## What this is

Vantik is a fork of [Tegon](https://github.com/RedPlanetHQ/tegon), an open-source, dev-first
alternative to Jira/Linear that was archived by its original maintainers (RedPlanetHQ) in
June 2025. The original project nailed the core data model — projects, issues, workflows,
Kanban and list views, triage — but was built around human teams using AI as an assist
feature, not agents as the primary actor.

This fork exists to invert that: agents create, plan, and update work here as their default
mode of operation, with the UI serving as a human review/audit layer rather than the primary
interface.

**Status:** early-stage personal fork. Expect breaking changes and incomplete rebranding in
places. The codebase builds and runs locally (see [Getting Started](#getting-started));
dependencies were brought up to date in July 2026: NestJS 11, Prisma 6, React 19,
Next 15, TanStack Query 5, Tiptap 3, AI SDK 7, and zod 4. Still pending: trigger.dev 4
(the whole automations subsystem is being rethought first) and Next 16. Runtime
`NEXT_PUBLIC_*` configuration is no longer the obstacle it was: the browser now reads
those settings from the server at `/api/v1/config`, so self-hosted installs still
configure them at container start and `publicRuntimeConfig` is gone.

## Attribution & license

Vantik is a derivative work of [RedPlanetHQ/tegon](https://github.com/RedPlanetHQ/tegon),
licensed under [AGPL-3.0](./LICENSE). All credit for the original architecture, data model,
and implementation goes to the Tegon team. This fork is maintained independently and is not
affiliated with or endorsed by RedPlanetHQ or Tegon.

## Getting started (self-hosting)

Prerequisites: Docker (or Podman with the compose provider). The compose stack is
turn-key — it runs the webapp, API server, and all backing services (postgres, redis,
SuperTokens, Typesense), and the server applies database migrations
on startup.

```bash
cp .env.example .env   # defaults work out of the box; change secrets for real deployments
docker compose up -d
```

Open http://localhost:3000 and sign in with any email address — without SMTP configured,
the magic login link is printed to the server log instead of emailed:

```bash
docker compose logs server | grep -A5 "magic link"
```

For a non-localhost deployment, set `FRONTEND_HOST` / `BACKEND_HOST` in `.env` to your
domain and change `POSTGRES_PASSWORD`, `TYPESENSE_API_KEY`, and `TRIGGER_TOKEN`.

Optional services (the server logs an error and continues without them):

- **trigger.dev** — powers background actions/automations;
  [self-hosting guide](https://trigger.dev/docs/self-hosting). Point `TRIGGER_API_URL` /
  `TRIGGER_DATABASE_URL` at your trigger.dev deployment and its database.
- **ollama** — local LLM for AI features when `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` are unset.
- **SMTP** — set the `SMTP_*` variables to send real emails.

## Local development

Prerequisites: Node.js ≥ 20, pnpm 10 (`npm i -g pnpm@10`), and Docker/Podman.
For hot reload, run only the backing services in containers and the apps on the
host (the backing services publish their ports on localhost for exactly this):

```bash
cp .env.example .env

# 1. Backing services only (skips the webapp/server containers)
docker compose up -d postgres redis supertokens typesense

# 2. Dependencies + database schema
pnpm install
pnpm migrate

# 3. Run the server (:3001) and webapp (:3000) with hot reload
pnpm dev
```

If the full stack is already running in containers, free the app ports first
with `docker compose stop webapp server`.

## Documentation

Docs live in `apps/docs` (Docusaurus) and are deployed to GitHub Pages on every push to
`main` that touches that directory — see `.github/workflows/deploy-docs.yml`. Once
`vantik.dev`'s DNS is pointed at GitHub Pages (see `apps/docs/static/CNAME` and
[GitHub's custom domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)),
they'll be live there. Until then, GitHub will still build and serve them at
`https://cmunte132.github.io/vantik/`.

To work on docs locally:

```bash
cd apps/docs
pnpm install
pnpm run gen-api-docs vantik   # regenerate API reference from openapi/openapi.yml
pnpm start                     # local dev server with hot reload
```

One-time repo setup still needed: in GitHub repo Settings → Pages, set the source to
"GitHub Actions" (not "Deploy from a branch") for the workflow above to work.

## Roadmap (planned direction, not yet built)

- [ ] Get the existing stack building and running self-hosted under this fork
- [ ] MCP server for agent-driven issue/project CRUD
- [ ] Rework the automation framework (originally "Tegon Actions") around agent-primary
      workflows rather than human-triggered automations
- [ ] Multi-repo/multi-project navigation for a single human reviewer across several
      agent-managed codebases

Done:
- [x] Rebrand from Tegon, remove Slack integration and Cloud marketing content
- [x] Docs migrated off Mintlify to a self-hosted Docusaurus site on GitHub Pages,
      replacing the old `apps/website` marketing app entirely

## Contributing

This is currently a personal project. Issues and PRs may be considered but there's no
formal process yet.
