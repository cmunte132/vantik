# Vantik agent skills

Two guides teach an LLM agent to use Vantik well. Each guide is an
[agent skill](https://agentskills.io). Claude Code, Codex, Cursor, and many other
agents load a skill on demand, so it costs no context until the work starts.

| Skill | What it teaches |
| --- | --- |
| `working-vantik-issues` | Keep the tracker current while the work happens, and keep the issues few and large. |
| `working-vantik-knowledge` | Load the context before the work starts, record one fact at a time, and supersede an old fact and do not contradict it. |

## How to install

Each guide needs an agent that reaches Vantik over MCP. Make a token in
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

These commands give the issues guide. For another guide, put its name and a
slash after `agent-skill/` in the URL, for example
`agent-skill/working-vantik-knowledge/AGENTS.md`.

The MCP server also sends a short form of the rules to each client that
connects, in the `instructions` field of MCP. Claude Code and Codex keep that
text in the context for the whole session, so an agent there gets the rules
even before it loads a skill.

## Hooks

A skill is advice, and the agent decides when to read it. Hooks make these parts
of the guidance certain:

- **At the start of a session**, the agent gets a list of the issues that it
  has in progress, with how much of each Definition of Done is met. After a
  compaction, the agent gets the list again.
- **On each prompt**, Vantik compares the prompt with the knowledge bank. If
  pages match closely, the agent gets their titles and an instruction to call
  `load_context`. Vantik sends the titles only, and names each page one time in
  a session.
- **Before the agent stops**, Vantik examines each issue that the agent has in
  progress. If an issue has had no update from the agent for 20 minutes of this
  session, Vantik holds the agent once and asks it to record where the issue
  stands. If the session did not touch that issue, the agent can say so in one
  line and stop. Vantik asks once for each quiet period.
- **Before the agent stops**, Vantik also finds work that has no issue. If the
  session changed files five times or more, and nothing is in progress under the
  name of the agent, Vantik holds the agent once and asks it to find or file the
  issue. If the change is too small, or the repository does not use Vantik, the
  agent can say so in one line and stop.
- **Before the agent stops**, Vantik also finds knowledge that the agent did not
  record. If the session changed files ten times or more, and the agent wrote
  nothing to the knowledge bank in that period, Vantik holds the agent once and
  asks it to record what the work taught with `remember`, and to supersede each
  entry that the work made false. If the work taught nothing new, the agent can
  say so in one line and stop. Vantik asks again only after ten more edits.

The rules are on the server, so the hooks only relay the answer. The hooks
write nothing to the tracker. If Vantik does not answer, the agent continues as
if there were no hooks.

**Settings → Agents** shows the hooks for each agent:

| Agent | How the hook reaches Vantik | Where the file goes |
| --- | --- | --- |
| Claude Code | An `mcp_tool` hook, through the MCP server that you configured. It holds no token. | `.claude/settings.json` |
| Codex | The same. The edit hook matches `apply_patch`. | `.codex/hooks.json` |
| Cursor | A `curl` command that reads `VANTIK_TOKEN` from the environment. Cursor cannot add context to a prompt, so the page titles come after the next tool. Cursor cannot hold an agent at a stop, so the reminder comes back as the next message. | `.cursor/hooks.json` |

The endpoint behind them is `POST /v1/agent-hooks/<event>?harness=<harness>`.
Any other agent that can run a command at the start of a session and before it
stops can use it.

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
