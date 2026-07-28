# @vantikhq/cli

The `vantik-cli` command. It does two jobs. It deploys Vantik actions with
`login`, `init`, `deploy`, and `logout`. It also works issues from the terminal
with `task …`.

## Authentication

Each task command needs a token. The command looks for a token in this order:

1. `ACCESS_TOKEN` in the environment, with `BASE_HOST` for the host.
2. The profile that `vantik-cli login` writes.
3. `VANTIK_TOKEN`, with `VANTIK_URL`. agent-core reads the same two variables.

Make a token under **Vantik → Settings → Agents**. The workspace then records
the work against an agent identity. You can also use a personal token from
**Settings → API**. `VANTIK_URL` points at the root of the API. Give the address
of the server (`http://localhost:3001`), or the address of the webapp proxy
(`https://vantik.example.com/api`).

## How to work issues

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

Every command accepts `--json` and then gives the raw output. For the full list
of flags, run `vantik-cli task --help`, or `vantik-cli task <command> --help`.

## The product axis

A team says who does the work. The second axis says what the software is made
of. A **product** is what the workspace ships. A **module** is where the code
is: a repository, a path in a repository, or a service. A **capability** is what
the software does for the people who use it.

```bash
# Read the map. `modules` gives the repositories of each module, so you can
# find the module of a checkout.
vantik-cli products
vantik-cli modules
vantik-cli capabilities

# Put work on the map
vantik-cli task create Rate-limit the webhook --module server --capability "Webhooks"
vantik-cli task update ENG-42 --module server webapp
vantik-cli task update ENG-42 --no-capability

# Find the other open work on the code that you are about to change
vantik-cli task list --module server --category STARTED
vantik-cli task list --product cloud
```

An issue records its modules, and it never records a product. Therefore
`--product` finds the modules that the product owns, and also the modules that
the product links to. If you give `--product` and `--module` together, the
command finds only the modules in both sets.

These listings are read-only, and that is the intent. The people who own the
code draw the map of a workspace in the app.

### No opinions here

The CLI is neutral, and that is the intent. It files what you tell it to file.
It has no view on the size of an issue, and no view on the work that deserves a
project. That opinion lives in two places only: the MCP tools `create_task` and
`create_project`, and the `working-vantik-issues` skill. Those two guide an
agent to a small number of large issues under projects. A person at a terminal
knows what that person wants, so `task create tweak` works.

## How to deploy actions

For `init`, `deploy`, and the format of the action configuration, read the
[documentation for actions](../../apps/docs/docs/actions).
