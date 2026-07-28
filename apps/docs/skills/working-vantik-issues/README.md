# working-vantik-issues

An opinionated guide that teaches an LLM agent to work Vantik's issue tracker
well: **keep the tracker current while the work happens** — pick the issue up
before the first edit, tick the Definition of Done as each criterion is met,
close with a resolution — and keep issues **few and meaty** rather than many and
thin. It is the judgment layer above the `create_task` tool's built-in floor
(which already requires a real description and, for a top-level issue,
acceptance criteria).

The two halves pull in opposite directions on purpose: restraint on filing,
generosity on progress. An agent that reads only the filing half goes quiet, and
a tracker that learns what happened only at close time is one nobody can trust
mid-flight.

The guidance is authored in two forms here, and Vantik serves four: **Settings →
Agents** offers a download and a one-line install for whichever file your tool
actually reads, so nobody has to find this directory to install it. `CLAUDE.md`
and the Cursor `.mdc` rule are derived from `AGENTS.md` when they are served —
they are not files here, and must not become files here, or the same guidance
starts drifting in four places.

What follows is for changing the guidance, or installing it by hand.

## Connect first

Both forms assume the agent can reach Vantik over MCP. Provision a token in
**Vantik → Settings → Agents**, which mints an agent identity so the work is
attributed to the agent rather than to you, and hands back a ready-to-paste
`.mcp.json` and `claude mcp add` command pointing at `/api/v1/mcp`. Drop that
into your client, then add the guidance below.

## Option A — Claude Code skill (recommended)

`SKILL.md` is a Claude Code skill as-is. It loads on demand, so it costs no
context until issue work actually comes up. Install it into a project:

```bash
mkdir -p .claude/skills/working-vantik-issues
cp SKILL.md .claude/skills/working-vantik-issues/
```

Or place it in `~/.claude/skills/` to make it available across all projects.
Claude invokes it automatically before starting a substantial piece of work and
whenever it creates, updates, or closes Vantik issues; you can also call it
explicitly with `/working-vantik-issues`.

If an agent still works quietly and only reports at the end, the on-demand
loading is usually why: nothing in the task looked like "issue work" until it
was over. Install `AGENTS.md` or the derived `CLAUDE.md` instead (Option B) —
always-in-context guidance is what makes the tracker-first habit stick.

## Option B — AGENTS.md snippet (portable)

For runners that read an `AGENTS.md` instead of Claude Code skills (Cursor,
Windsurf, Codex, or a plain system prompt), copy the section from `AGENTS.md`
into your repo's `AGENTS.md`. It is a tightened version of the same guidance,
written to sit always-in-context rather than load on demand.

## Files

Authored here:

| File | For | Loading |
| --- | --- | --- |
| `SKILL.md` | Claude Code | On demand, when issue work comes up |
| `AGENTS.md` | Other agent runners | Always in context |
| `README.md` | Humans installing it | — |

Derived from `AGENTS.md` by the server, at `/v1/agent-skill/:file`:

| Served as | For | Difference |
| --- | --- | --- |
| `CLAUDE.md` | Claude Code, always in context | The note above the snippet is dropped |
| `working-vantik-issues.mdc` | Cursor project rules | That note becomes Cursor's frontmatter |

Keep the two authored files in sync: `SKILL.md` is the fuller source, `AGENTS.md`
its condensed form. When the opinion changes, change both — the derived forms
follow on their own.
