# @vantikhq/cli

The `vantik` command. It works issues, projects, the product axis and the
knowledge bank from the terminal. The help text calls the program
`vantik-cli`, but the command that you type is `vantik`.

The full reference, with each command and flag, is the
[CLI reference](https://docs.vantik.dev/developers/cli). In this
repository, it is `apps/docs/docs/developers/cli.mdx`.

## How to sign in

Run `vantik login`. The command opens Vantik in the browser, and it writes a
token that acts as you to a local profile. For a server that is not at
`https://app.vantik.dev`, first set `BASE_HOST` to the address of the webapp.

To use a token from the environment, make one in Vantik under
**Settings → My account → API**, in **Access tokens**. Set **Acts as** to
**Its own identity — an agent**, and the workspace records the work against
that agent. Set it to **You** for a token that acts as you.

The CLI finds the token in this order:

1. `ACCESS_TOKEN` in the environment.
2. The profile that `vantik login` writes.
3. `VANTIK_TOKEN` in the environment.

It finds the address in this order: `BASE_HOST`, then the address in the
profile, then `VANTIK_URL`, then `http://localhost:3001`. The CLI adds `/api`
to `BASE_HOST` and to the profile address. `VANTIK_URL` is the root of the
API, for example `https://vantik.example.com/api`.

## Examples

```bash
# Issues
vantik task list --team ENG --category STARTED
vantik task get ENG-42
vantik task search connection pool --category COMPLETED
vantik task create Fix the flaky checkout test --team ENG --priority high
vantik task pick-up ENG-42
vantik task note ENG-42 Reproduced only under load
vantik task close ENG-42 --resolution "Bumped the pool to 20"

# Projects
vantik project create Search rewrite --team ENG --description - < plan.md

# The product axis: read the map, and change it
vantik modules
vantik module add-repo server acme/platform --path apps/server
vantik capability create Webhooks --module server
vantik task list --module server --category STARTED

# The knowledge bank
vantik kb context --scope apps/server --task "Add a rate limit"
vantik kb append Payments "Refunds settle in two business days"
vantik kb pull
```

Each command that reads or writes data takes `--json`, and then prints the
raw result. Run `vantik <command> --help` for the flags of one command.

## No opinions here

The CLI is neutral, and that is the intent. It files what you tell it to file.
It has no view on the size of an issue, and no view on the work that deserves a
project. That opinion lives in two places only: the MCP tools `create_task` and
`create_project`, and the `working-vantik-issues` skill. Those two guide an
agent to a small number of large issues under projects. A person at a terminal
knows what that person wants, so `task create tweak` works.

The CLI cannot start an agent run. `vantik task runs` only shows the runs of a
task.
