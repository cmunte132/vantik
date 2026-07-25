# working-vantik-knowledge

An opinionated guide that teaches an LLM agent to use Vantik's knowledge bank
well: load context before starting work, record **one fact at a time**,
supersede rather than contradict, and consolidate instead of piling up.

It is the judgment layer above the floor the `remember` tool already enforces
(an entry has to be a single self-contained fact, not a session summary), and
the companion to [`working-vantik-issues`](../working-vantik-issues/README.md) —
issues are the work, the bank is what the work taught you.

The guidance is authored in two forms here, and Vantik serves four: **Settings →
Agents** offers a download and a one-line install for whichever file your tool
actually reads. `CLAUDE.md` and the Cursor `.mdc` rule are derived from
`AGENTS.md` when they are served — they are not files here, and must not become
files here, or the same guidance starts drifting in four places.

## Connect first

Both forms assume the agent can reach Vantik over MCP. Provision a token in
**Vantik → Settings → Agents**, which mints an agent identity so entries are
attributed to the agent rather than to you — which is the whole point of
provenance on a knowledge bank, since an agent-written claim and a human-written
one are identical as text.

## Option A — Claude Code skill (recommended)

`SKILL.md` is a Claude Code skill as-is. It loads on demand, so it costs no
context until knowledge work actually comes up. Install it into a project:

```bash
mkdir -p .claude/skills/working-vantik-knowledge
curl -fsSL "$VANTIK_URL/api/v1/agent-skill/working-vantik-knowledge/SKILL.md" \
  -o .claude/skills/working-vantik-knowledge/SKILL.md
```

## Option B — AGENTS.md snippet

For runners that read an `AGENTS.md`, a `CLAUDE.md`, or a Cursor project rule.
Append the served file to whatever your tool already loads:

```bash
curl -fsSL "$VANTIK_URL/api/v1/agent-skill/working-vantik-knowledge/AGENTS.md" >> AGENTS.md
```

The served copies have the note-to-humans at the top of `AGENTS.md` stripped —
once you have chosen a format, a note explaining which format to choose is
answering a question you just answered.

## Changing the guidance

Edit `SKILL.md` and `AGENTS.md` here. Both are shipped in the server image and
read at boot; there is nothing to regenerate. Keep them saying the same thing —
the skill can afford more room, but the two must not disagree, or an agent's
behaviour depends on which one its harness happened to load.
