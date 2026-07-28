# working-vantik-knowledge

This guide has an opinion, and it teaches an LLM agent to use the Vantik
knowledge bank well. It says four things: load the context before you start
work, record **one fact at a time**, supersede an old fact and do not contradict
it, and consolidate the entries instead of a collection that only grows.

This guide is the layer of judgement above the minimum of the `remember` tool.
That tool already needs an entry that is one complete fact, and not a summary of
a session. This guide is also the companion of
[`working-vantik-issues`](../working-vantik-issues/README.md). The issues are
the work, and the bank is what the work taught you.

A person authors the guidance here in two forms, and Vantik serves four.
**Settings → Agents** gives a download and a one-line install command for the
file that your tool reads. The server makes `CLAUDE.md` and the Cursor `.mdc`
rule from `AGENTS.md` when it serves them. They are not files here, and they must
not become files here. If they do, the same guidance becomes different in four
places.

## Connect first

Both forms need an agent that reaches Vantik over MCP. Make a token in
**Vantik → Settings → Agents**. That page makes an agent identity, so the bank
records each entry against the agent and not against you. This provenance is the
purpose of the bank, because the text of a claim from an agent and the text of a
claim from a person are the same.

## Option A — a Claude Code skill (the better method)

`SKILL.md` is a Claude Code skill, and it needs no change. Claude loads it on
demand, so it costs no context until the knowledge work starts. To install it in
a project, run:

```bash
mkdir -p .claude/skills/working-vantik-knowledge
curl -fsSL "$VANTIK_URL/api/v1/agent-skill/working-vantik-knowledge/SKILL.md" \
  -o .claude/skills/working-vantik-knowledge/SKILL.md
```

## Option B — the AGENTS.md text

Some runners read an `AGENTS.md` file, a `CLAUDE.md` file, or a project rule of
Cursor. For those, add the served file to the end of the file that your tool
already loads:

```bash
curl -fsSL "$VANTIK_URL/api/v1/agent-skill/working-vantik-knowledge/AGENTS.md" >> AGENTS.md
```

The `AGENTS.md` file here has a note at the top for a person to read. The server
removes that note from each copy that it serves. After you select a format, a
note that tells you how to select a format answers a question that you answered
already.

## How to change the guidance

Edit `SKILL.md` and `AGENTS.md` here. The server image holds both files, and the
server reads them when it starts. You generate nothing. Keep the two files in
agreement. The skill has more space, but the two must not disagree. If they
disagree, the behaviour of an agent depends on the file that its harness loaded.
