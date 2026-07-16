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

**Status:** early-stage personal fork. Expect breaking changes, incomplete rebranding in
places, and a codebase that hasn't been built or run yet since the rename. See
[Getting Started](#getting-started) below before assuming anything works out of the box.

## Attribution & license

Vantik is a derivative work of [RedPlanetHQ/tegon](https://github.com/RedPlanetHQ/tegon),
licensed under [AGPL-3.0](./LICENSE). All credit for the original architecture, data model,
and implementation goes to the Tegon team. This fork is maintained independently and is not
affiliated with or endorsed by RedPlanetHQ or Tegon.

## Getting started

This repo hasn't been built or verified since the rebrand. Before relying on anything below,
treat it as a starting point to debug, not a working quickstart:

```bash
cp .env.example .env
# fill in required values — check docker-compose.yaml and apps/server for what's needed
docker compose up
```

Expect dependency rot given the ~1 year gap since the original project's last release
(0.3.11-alpha, March 2025) — package versions, Trigger.dev integration, and auth flows are
the most likely things to need attention first.

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
