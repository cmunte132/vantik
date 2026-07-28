# working-vantik-issues

This guide has an opinion, and it teaches an LLM agent to use the Vantik issue
tracker well. It says two things.

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

A person authors the guidance here in two forms, and Vantik serves four.
**Settings → Agents** gives a download and a one-line install command for the
file that your tool reads. Nobody needs to find this directory. The server makes
`CLAUDE.md` and the Cursor `.mdc` rule from `AGENTS.md` when it serves them. They
are not files here, and they must not become files here. If they do, the same
guidance becomes different in four places.

The text below is for a change to the guidance, or for an installation by hand.

## Connect first

Both forms need an agent that reaches Vantik over MCP. Make a token in
**Vantik → Settings → Agents**. That page makes an agent identity, so the
workspace records the work against the agent and not against you. It also gives
you a `.mcp.json` file and a `claude mcp add` command for `/api/v1/mcp`. Copy
that into your client, and then add the guidance below.

## Option A — a Claude Code skill (the better method)

`SKILL.md` is a Claude Code skill, and it needs no change. Claude loads it on
demand, so it costs no context until the issue work starts. To install it in a
project, run:

```bash
mkdir -p .claude/skills/working-vantik-issues
cp SKILL.md .claude/skills/working-vantik-issues/
```

You can also put the file in `~/.claude/skills/`. It is then available in all
your projects. Claude invokes the skill automatically before a substantial piece
of work, and each time that it creates, updates, or closes a Vantik issue. You
can also invoke it with `/working-vantik-issues`.

If your agent still works quietly, and it reports only at the end, the cause is
usually the load on demand: no part of the task looked like issue work until the
task was complete. For that agent, install `AGENTS.md` or the derived `CLAUDE.md`
instead. See Option B. Guidance that is always in the context is what makes the
habit permanent.

## Option B — the AGENTS.md text (portable)

Some runners read an `AGENTS.md` file, and not a Claude Code skill. Cursor,
Windsurf, and Codex do this, and so does a plain system prompt. For those,
copy the section from `AGENTS.md` into the `AGENTS.md` file of your repository.
That section is a shorter form of the same guidance, and a person wrote it to
sit always in the context.

## The files

A person authors these files here:

| File | For | How it loads |
| --- | --- | --- |
| `SKILL.md` | Claude Code | On demand, when the issue work starts |
| `AGENTS.md` | Other agent runners | Always in the context |
| `README.md` | The person who installs it | — |

The server makes these files from `AGENTS.md`, at `/v1/agent-skill/:file`:

| The server serves it as | For | The difference |
| --- | --- | --- |
| `CLAUDE.md` | Claude Code, always in the context | The server removes the note above the text |
| `working-vantik-issues.mdc` | The project rules of Cursor | That note becomes the frontmatter for Cursor |

Keep the two authored files the same. `SKILL.md` is the fuller source, and
`AGENTS.md` is its shorter form. When the opinion changes, change both files.
The server then makes the derived files again.
