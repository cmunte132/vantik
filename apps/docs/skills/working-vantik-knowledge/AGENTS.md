<!--
Portable version of the working-vantik-knowledge skill, for agent runners that
read an AGENTS.md (Cursor, Windsurf, Codex, plain system prompts) rather than
Claude Code skills. Paste the section below into your repo's AGENTS.md. Claude
Code users should install the skill instead — see README.md — since it loads on
demand and keeps context free until knowledge work actually comes up.
-->

## Working the Vantik knowledge bank

Vantik keeps a workspace knowledge bank, reachable through the same MCP server
as the issue tracker. It holds **pages** (canonical documentation, written as
prose for humans) and **entries** (single asserted facts appended by agents,
each carrying who claimed it, where it applies, and whether anyone has
confirmed it). Tools: `load_context`, `recall_knowledge`, `list_pages`,
`read_page`, `remember`, `write_page`, `consolidate_knowledge`,
`knowledge_gaps`.

**Load context before you start work, not after you get stuck.** Call
`load_context` with the area you are about to touch and a token budget, before
reading a single file. You do not need a question — at the start of a task you
do not yet know what you do not know, which is exactly why a scope is enough.
Everything it returns is something you would otherwise have had to rediscover,
and it works across harnesses: a fact another tool wrote is a fact you get.

**One entry is one fact.** Not a summary of your session. An entry that bundles
six claims cannot be scoped, confirmed or corrected one claim at a time, and
correcting knowledge one claim at a time is the entire reason entries exist
rather than a shared document. Learned six things? Call `remember` six times.
Scope each one (`scope: "apps/server"`), or it is served everywhere, to
everyone, forever.

**Worth remembering:** a decision and why it went that way, a gotcha that cost
you time, a convention that is not obvious from the code, a constraint someone
stated that is written down nowhere. **Not worth remembering:** what you did
this session (that is a note on the issue), anything already in the page body,
anything the code says plainly. Never secrets or credentials — the bank is
readable by every agent in the workspace.

**Prefer appending to an existing page.** Check `list_pages` first. Pages are
few, broad and long-lived; the facts under them are many. A bank of forty thin
pages is one nobody can navigate, and navigability is the whole product. Use
`write_page` only when no existing page fits, and give it a real body.

**Contradictions: supersede, never stack.** If what you learned contradicts
something in the bank, pass `supersedes` with the id of the entry it replaces.
Two contradictory facts are worse than neither, because a reader — usually
another agent, acting on it — cannot tell which one the workspace believes.

`remember` searches before it writes. When near matches come back **nothing was
written**: read them, then either supersede one or pass `distinct: true`. Do not
pass `distinct` without reading them.

**Consolidate** when a page has grown facts that now read as a paragraph:
`consolidate_knowledge` folds them into the body and stops them being served
separately, so one fact is not returned twice.

**Limits you will meet**, enforced server-side: ten untriaged entries per page
per token (the error names the ones in your way — consolidate or supersede them,
do not find another page to dump into); `LOCKED` pages are readable but not
appendable by agents. Everything you write lands as proposed and is served to
nobody until a human accepts it, so write for the reviewer and for the stranger
after them.

`knowledge_gaps` lists questions the bank could not answer, most-asked first. If
you just spent an hour answering one, that hour is worth an entry.
