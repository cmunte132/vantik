<!--
Portable version of the working-vantik-issues skill, for agent runners that
read an AGENTS.md (Cursor, Windsurf, Codex, plain system prompts) rather than
Claude Code skills. Paste the section below into your repo's AGENTS.md. Claude
Code users should install the skill instead — see README.md — since it loads
on demand and keeps context free until issue work actually comes up.
-->

## Working Vantik issues

You reach Vantik's issue tracker through its MCP server. Connect once with a
token from **Vantik → Settings → Agents** (it acts as its own identity, so your
edits are attributed to the agent, not to a person). Tools: `search_tasks`,
`get_task`, `find_similar_tasks`, `list_tasks`, `create_task`, `update_task`,
`pick_up_task`, `add_note`, `close_task`, `list_projects`, `create_project`.

**One rule above the rest: an issue is one self-contained feature, bug, or
objective, with enough substance that someone could pick it up cold.** Prefer
*few and meaty* over *many and thin* — a tracker full of light tickets is where
the signal drowns.

- **Substantial by default.** A fair chunk of work, not a line item. A
  five-minute change or a single step of something larger is a sub-task, a
  checklist entry, or a note — not its own issue.
- **Span as few issues as possible.** Reach for one substantial issue with
  sub-tasks before several thin ones. Splitting is the exception you justify.
- **Group what genuinely spans several issues into a project.** Work comes in
  three sizes: a sub-task is a step of one issue, an issue is one contained
  objective, a **project** is an objective that needs several issues. When work
  is too big for one issue it goes *up* into a project, never sideways into
  loose siblings — that is what keeps "few and meaty" from becoming one bloated
  issue.
- **The moment to open a project is the second issue.** About to file an issue
  serving the same objective as one you already filed? `create_project` and pass
  `project` on both. `list_projects` first and reuse what exists: projects are
  few, long-lived and meaningful, never one per work session, never one for a
  single issue. Issues that turn out to belong together can be gathered later
  with `update_task` and `project`.

**Before filing, stop at the first match:**

1. Part of an objective that already has an issue? `add_note` to it, or
   `create_task` with `parent` for a sub-task. Not a new top-level issue. A
   genuinely separate issue serving that objective belongs in the same
   `project`.
2. A passing observation or "we should look at this"? That's a note.
3. Can't state what "done" looks like? It's a note until you can.
4. A genuine, self-contained objective with a clear done? File it.

Always `search_tasks` first, including `COMPLETED` — it may already be fixed,
and you should reference or reopen that instead of duplicating it.

**A good issue has** a one-line title, a description of the problem and *where
it lives*, and acceptance criteria — concrete checks for "done". If you can't
write the criteria, the issue isn't contained yet.

**Working an issue:** `pick_up_task` before you start; `add_note` as you go
(notes are searchable — write them for the next person); `close_task` **with a
resolution**, which becomes the searchable record of how it was fixed and makes
recurring problems findable later.
