---
name: working-vantik-issues
description: >-
  How to work the Vantik issue tracker as an agent over MCP: keep issues few
  and meaty, group them under projects, file well-formed work, and consolidate
  instead of proliferating. Use whenever creating, updating, or closing Vantik
  issues.
---

# Working Vantik issues

One rule sits above the rest: **an issue is one self-contained feature, bug,
or objective, with enough substance that someone could pick it up cold.**
Prefer *few and meaty* over *many and thin*. A tracker full of light tickets
is where the signal drowns — for the humans reading it as much as for you.

The `create_task` tool enforces a floor (a real description, and acceptance
criteria for a top-level issue). This skill is the judgment above that floor:
what deserves an issue at all, how big it should be, and how to avoid sprawl.

## How big is an issue?

**Substantial by default.** An issue is a fair chunk of work — a feature
worth building, a bug worth a focused fix, an objective worth pursuing — not
a line item. If it's a five-minute change or a single step of something
larger, it is a sub-task, a checklist entry, or a note, not its own issue.

**Span as few issues as possible.** When you're looking at a body of work and
wondering how many issues to split it across, the answer is: as few as you
can. Reach for one substantial issue with sub-tasks or a checklist before you
reach for several. Splitting is the exception you justify, not the default.

The estimate doesn't have to be precise — sizing never is. The posture is
what matters: default big, consolidate hard, and only split when a piece is
genuinely independent.

## Three sizes, not one

Work comes in three sizes, and using the wrong one is what makes a tracker
unreadable:

| Size | Use | Tool |
| --- | --- | --- |
| **Sub-task** | A step of one issue. | `create_task` with `parent` |
| **Issue** | One self-contained feature, bug or objective. | `create_task` |
| **Project** | An objective that genuinely needs several issues. | `create_project` |

Sub-tasks hold the steps of one issue together; a project holds the *issues*
together. Both exist so that "keep issues few" never becomes "cram unrelated
work into one issue" — when work is too big for one issue, it goes **up** into
a project, not sideways into loose siblings.

**The moment to open a project is the second issue.** If you are about to file
an issue and one you already filed serves the same objective, stop: open a
project, pass `project` on both. A handful of issues that only someone who
already knows the plan can connect is exactly what a project prevents.

Before filing, `list_projects`. If the work belongs to an objective already
underway, file into it rather than leaving it loose. Projects should be few,
long-lived and meaningful — one per real objective, not one per work session.
Never open one for a single issue: that issue is already the unit of work. If
issues turn out after the fact to serve one objective, gather them with
`update_task` and `project`.

## Before you file: is this even an issue?

Walk down this list and stop at the first match.

1. **Part of an objective that already has an issue?** Add a note to that
   issue (`add_note`), or file it as a **sub-task** (`create_task` with
   `parent`). Do not open a new top-level issue.
   Genuinely a *separate* issue serving the same objective? Then it belongs in
   the same **project** — pass `project`.
2. **A passing observation, a finding, or a "we should look at this"?** That
   is a note on the most relevant issue, not a new one.
3. **You cannot state what "done" looks like?** Then it is not a contained
   objective yet. It is a note until it is.
4. **A genuine, self-contained objective with a clear done?** File it.

Always `search_tasks` first — and search `COMPLETED` too, in case it was
already fixed and you should be reopening or referencing that instead.

## What a good issue contains

- **Title** — the objective in a line.
- **Description** — the problem and *where it lives* (the file, the flow, the
  surface). Enough that a reader who wasn't there understands it.
- **Acceptance criteria** — what "done" looks like, as concrete checks. This
  is the forcing function: if you can't write them, the issue isn't contained.

Write it for a future reader who has none of your context.

## Consolidate, don't proliferate

- Several thoughts about **one** objective are **one** issue with a checklist
  or sub-tasks — not several issues.
- When you discover related work mid-task, prefer a sub-task or a note over a
  new top-level sibling.
- If you catch yourself about to file the third small ticket for the same
  feature, stop: they are one issue.
- If they really are three substantial issues, they are one **project**.

## Anti-patterns

- A title with an empty or one-line body.
- "Investigate X", "Look into Y" as top-level issues — those are notes.
- Splitting a single PR-sized objective across many tickets.
- Filing a near-duplicate instead of adding to the issue that exists.
- A scatter of loose issues that only make sense read together, with no
  project to say so.
- A project per work session, or a project holding one issue.

## Working an issue

- `pick_up_task` before you start, so the board shows it is being handled.
- `add_note` as you go — notes are searchable; write them for the next person.
- `close_task` **with a resolution**: it becomes the searchable record of how
  this was fixed, which is what makes recurring problems findable later.
