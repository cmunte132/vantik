# @vantikhq/cli

The `vantik-cli` command. It does two jobs: deploying Vantik actions
(`login`, `init`, `deploy`, `logout`), and working issues from the terminal
(`task …`).

## Authentication

The task commands need a token. They look, in order, for:

1. `ACCESS_TOKEN` in the environment (with `BASE_HOST` for the host).
2. The profile written by `vantik-cli login`.
3. `VANTIK_TOKEN` (with `VANTIK_URL`), the same variables agent-core reads.

Provision a token under **Vantik → Settings → Agents** so the work is
attributed to an agent identity, or use a personal token from **Settings →
API**. `VANTIK_URL` points at the API root — the server directly
(`http://localhost:3001`) or the webapp proxy (`https://vantik.example.com/api`).

## Working issues

```bash
# Read
vantik-cli task list --team ENG --category STARTED
vantik-cli task get ENG-42
vantik-cli task search connection pool --category COMPLETED
vantik-cli task similar ENG-42

# Write
vantik-cli task create Fix the flaky checkout test --team ENG --priority high
vantik-cli task create Index note bodies --project "Search rewrite"
vantik-cli task update ENG-42 --state "In Review"
vantik-cli task pick-up ENG-42
vantik-cli task note ENG-42 Reproduced only under load
vantik-cli task close ENG-42 --resolution "Bumped the pool to 20"
```

Every command takes `--json` for raw output. Run `vantik-cli task --help` (or
`… <command> --help`) for the full flag list.

## The product axis

A team says who works on something. The second axis says what the software is
made of: a **product** is what the workspace ships, a **module** is where the
code is (a repository, a path in one, a service), and a **capability** is what
the software does for its users.

```bash
# Read the map. `modules` lists the repositories each module sits in, which is
# what answers "which module is this checkout?"
vantik-cli products
vantik-cli modules
vantik-cli capabilities

# Place work on it
vantik-cli task create Rate-limit the webhook --module server --capability "Webhooks"
vantik-cli task update ENG-42 --module server webapp
vantik-cli task update ENG-42 --no-capability

# Ask what else is in flight around the code you are about to change
vantik-cli task list --module server --category STARTED
vantik-cli task list --product cloud
```

Filtering by `--product` widens to the modules that product owns and links to,
because an issue records modules and never a product. Naming both narrows to the
intersection.

The listings are read-only on purpose: a workspace's map is drawn in the app by
the people who own the code.

### No opinions here

The CLI is deliberately neutral: it files whatever you tell it to, with no view
on whether an issue is "substantial enough", or on when a body of work deserves
a project. That opinion lives only in the MCP `create_task` / `create_project`
tools and the `working-vantik-issues` skill, which steer an agent toward few,
meaty issues grouped under projects. A human at a terminal is trusted to know
what they want — so `task create tweak` just works.

## Deploying actions

See the [actions docs](../../apps/docs/docs/actions) for `init`, `deploy`, and
the action config format.
