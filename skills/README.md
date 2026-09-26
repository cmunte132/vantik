# Vantik agent skills

Two guides teach an LLM agent to use Vantik well. Each guide is an
[agent skill](https://agentskills.io). Claude Code, Codex, Cursor, and many other
agents load a skill on demand, so it costs no context until the work starts.

| Skill | What it teaches |
| --- | --- |
| `working-vantik-issues` | Keep the tracker current while the work happens, and keep the issues few and large. |
| `working-vantik-knowledge` | Load the context before the work starts, record one fact at a time, and supersede an old fact and do not contradict it. |

## How to install

Both guides need an agent that reaches Vantik over MCP. Make a token in
**Vantik → Settings → Agents**, and copy the configuration from that page into
your client. That page makes an agent identity, so the workspace records the
work against the agent and not against you.

Then install the guides with the
[skills CLI](https://github.com/vercel-labs/skills). The better source is your
own Vantik server:

```bash
DISABLE_TELEMETRY=1 npx skills add https://your-vantik-host
```

The guides name the MCP tools of the server, so the copy from your server is the
copy that matches it. After you upgrade Vantik, run `npx skills update`.
`DISABLE_TELEMETRY=1` stops the CLI from sending a report of the install. For a
source like this one, that report holds the name of your host. **Settings →
Agents** shows this command for each agent.

You can also install the guides from this repository:

```bash
npx skills add cmunte132/vantik
```

That copy follows `main`, which can be ahead of the Vantik version that you run.

Each command asks which guides to install, for which agents, and whether to
install them for this project or for all your projects. To install one guide
only, add `--skill working-vantik-issues`. To name the agent, add
`--agent claude-code`, `--agent codex`, or `--agent cursor`.

## Always in the context

A skill loads on demand. Sometimes an agent still works quietly, and reports only
at the end, because no part of the task looked like issue work until the task
was complete. Guidance that is always in the context is what makes the habit
permanent. For that agent, add the shorter form of the guide to a file that the
agent always reads:

```bash
# Claude Code
curl -fsSL https://your-vantik-host/api/v1/agent-skill/CLAUDE.md >> CLAUDE.md

# Codex, Cursor, and any other tool
curl -fsSL https://your-vantik-host/api/v1/agent-skill/AGENTS.md >> AGENTS.md
```

These commands give the issues guide. For the knowledge guide, put
`working-vantik-knowledge/` after `agent-skill/` in the URL.

## working-vantik-issues

This guide has an opinion, and it says two things.

First, **keep the tracker current while the work happens**. The agent picks the
issue up before its first edit. It ticks the Definition of Done as it meets each
criterion. It closes the issue with a resolution.

Second, **keep the issues few and large**, and not many and small.

This guide is the layer of judgement above the minimum of the `create_task`
tool. That tool already needs a real description, and it needs acceptance
criteria for a top-level issue.

The two halves pull in opposite directions, and that is the intent: control on
the number of new issues, and generosity on the reports of progress. An agent
that reads only the first half is quiet. A tracker that learns what happened
only at the close of an issue is a tracker that nobody trusts during the work.

Claude invokes the skill automatically before a substantial piece of work, and
each time that it creates, updates, or closes a Vantik issue. You can also
invoke it with `/working-vantik-issues`.

## working-vantik-knowledge

This guide has an opinion, and it says four things: load the context before you
start work, record **one fact at a time**, supersede an old fact and do not
contradict it, and consolidate the entries instead of a collection that only
grows.

This guide is the layer of judgement above the minimum of the `remember` tool.
That tool already needs an entry that is one complete fact, and not a summary of
a session. This guide is also the companion of `working-vantik-issues`. The
issues are the work, and the bank is what the work taught you.

The bank records each entry against the agent that wrote it. This provenance is
the purpose of the bank, because the text of a claim from an agent and the text
of a claim from a person are the same.

## How to change the guidance

A person authors each guide here in two forms:

| File | What it is | How it loads |
| --- | --- | --- |
| `<skill>/SKILL.md` | The skill, and the fuller source | On demand, when the work starts |
| `always-in-context/<skill>.md` | The shorter form of the same guidance | Always in the context |
| `README.md` | This file, for the person who installs the guides | — |

**A skill directory holds `SKILL.md` and nothing else.** `npx skills add` copies
the whole directory of a skill into the project of the user. Any other file in
that directory lands next to the skill.

Keep the two forms of a guide in agreement. The skill has more space, but the
two must not disagree. If they disagree, the behaviour of an agent depends on the
file that its harness loaded. When the opinion changes, change both files.

The server image holds this directory, and the server reads it when it starts.
You generate nothing. The server lists each `SKILL.md` in its discovery index at
`/.well-known/agent-skills/index.json`, with a digest, so `npx skills update`
finds a change. It also serves each form at `/v1/agent-skill/<skill>/<file>`:

| The server serves it as | For | The difference |
| --- | --- | --- |
| `SKILL.md` | A skill installed by hand | None |
| `AGENTS.md` | The end of an `AGENTS.md` | The server removes the note at the top |
| `CLAUDE.md` | The end of a `CLAUDE.md` | The server removes the note at the top |
| `<skill>.mdc` | The project rules of Cursor | That note becomes the frontmatter for Cursor |

The note at the top of each file in `always-in-context/` is for a person to
read. After you select a format, a note that tells you how to select a format
answers a question that you answered already.

`CLAUDE.md` and the `.mdc` rule are not files here, and they must not become
files here. If they do, the same guidance becomes different in four places.

A new guide needs its directory here, its shorter form in `always-in-context/`,
and an entry in `SKILLS` in
`apps/server/src/modules/agent-skill/agent-skill.catalogue.ts`. The server tests
fail if this directory and that list disagree.
