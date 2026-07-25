---
name: working-vantik-knowledge
description: >-
  How to use the Vantik knowledge bank as an agent over MCP: load context
  before starting work, remember one fact at a time, supersede rather than
  contradict, and consolidate instead of piling up. Use whenever recalling or
  recording what a workspace knows.
---

# Working the Vantik knowledge bank

The bank is one store serving two readers. Humans read **pages** — canonical
documentation, written as prose. Agents write **entries** — single asserted
facts appended to a page, each carrying who claimed it, where it applies, and
whether anyone has confirmed it.

Two rules sit above everything else:

1. **Load context before you start.** Not after you get stuck.
2. **One entry is one fact.** Not a summary of your session.

The tools enforce a floor. This skill is the judgment above it.

## Start every task by loading context

Call `load_context` with the area you are about to touch, before you read a
single file:

```
load_context(scope: "apps/server/prisma", tokenBudget: 2000)
```

You do not need a question. At the start of a task you do not yet know what you
do not know, which is precisely why the scope is enough — the bank returns what
previous sessions established about that area, under a budget you set.

This is the cheapest thing you will do all session. Everything it returns is
something you would otherwise have had to rediscover, and it works across
harnesses: a fact another tool wrote is a fact you get.

When you have an actual question, use `recall_knowledge` instead. Ask it before
investigating something from scratch — the answer may already be in the bank.

## What is worth remembering

Something a future session would otherwise have to work out again.

**Yes:**

- A decision and why it went that way ("redis holds only cache here; anything
  that must survive a restart goes in postgres")
- A gotcha that cost you time ("the compose webapp container needs
  `BACKEND_URL=http://server:3001` or its /api proxy 502s")
- A convention that is not obvious from the code
- A constraint someone stated that is not written down anywhere

**No:**

- What you did this session. That is a note on the issue, not knowledge.
- Anything already in the page body — read the page first.
- Anything the code says plainly. A fact that goes stale when someone renames a
  function was never knowledge, it was a duplicate of the code.
- Secrets, credentials, tokens. Ever. The bank is readable by every agent in
  the workspace.

## One fact per entry

This is the rule that decides whether the bank stays usable.

An entry that bundles six claims cannot be scoped, confirmed, or corrected one
claim at a time — and correcting knowledge one claim at a time is the entire
reason entries exist rather than a shared document. If you learned six things,
call `remember` six times.

`remember` will refuse an entry that reads as a list or a summary, and tell you
to split it. That refusal is the rule, not an obstacle to route around.

**Scope your facts.** A fact without a scope is served everywhere, to everyone,
forever. If it is true of `apps/server` and not of the webapp, say so:

```
remember(page: "Architecture", content: "…", scope: "apps/server")
```

## Prefer appending to an existing page

Check `list_pages` before you write anything down. Pages are **few, broad and
long-lived**; the facts under them are many. A bank of forty thin pages is one
nobody can navigate, and navigability is the whole product.

Reach for `write_page` only when there is genuinely no page the knowledge
belongs under. A page needs a real body — a title with nothing underneath it is
a stub that makes the tree worse rather than better.

## Contradictions: supersede, never stack

If what you learned contradicts something in the bank, **supersede it**:

```
remember(page: "Deployment", content: "…", supersedes: "<entry id>")
```

Two contradictory facts are worse than neither, because a reader cannot tell
which one the workspace believes — and the reader is usually another agent,
acting on it. Superseding keeps the old entry for audit and stops serving it.

`remember` searches before it writes. When near matches come back **nothing was
written**: read them, then either supersede one or pass `distinct: true` to say
this is a separate fact. Do not pass `distinct` without reading them; that is
the one move that turns this whole design into a rubber stamp.

## Consolidate when a page grows facts that read as a paragraph

`consolidate_knowledge` folds standing facts into the page body and marks them
folded, so the same thing is not served twice — once as narrative and once as
the entry it was written from.

You supply the rewritten body. Deciding how a set of facts reads as prose is the
judgment being asked for; the tool only makes sure the folded entries stop
being served separately.

## Limits you will meet, and what they mean

These are enforced by the server, not by this document, and they apply however
you call the API.

- **Untriaged entry budget.** Ten open `PROPOSED` entries per page per token. If
  you hit it, the error names the entries in your way. Consolidate or supersede
  them; do not look for another page to dump into.
- **`LOCKED` pages.** Maintained by hand. You can read them — recall and context
  both work — but you cannot append. Append to a related page instead.
- **`CURATED` is the default.** `OPEN` pages exist for scratch work where volume
  genuinely does not matter.

## Improving the bank

`knowledge_gaps` lists the questions agents asked that the bank could not
answer, most-asked first. It is the most direct answer available to "what should
I document next" — it says what people actually needed, rather than what
somebody thought to write down. If you just spent an hour answering one of
those questions, that hour is worth an entry.

## Your entries are reviewed

Everything you write lands as `PROPOSED` and is served to nobody until a human
accepts it. That is not a formality — it is what makes the bank trustworthy
enough to be worth reading.

Write for the reviewer, and for the stranger after them. A claim they cannot
evaluate is a claim they will archive.
