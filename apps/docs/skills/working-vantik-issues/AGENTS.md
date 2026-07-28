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
`update_criteria`, `pick_up_task`, `add_note`, `close_task`, `list_projects`,
`create_project`, `list_products`, `list_modules`, `list_capabilities`.

Two obligations. **Restraint on filing, generosity on progress** — "few and
meaty" governs how many issues exist, and says nothing about notes and criteria,
which should be frequent. Never let caution about creating issues become silence
on the issue you are working.

**Keep the tracker current while you work, not afterwards.**

- **Before you touch code:** `search_tasks` for the issue (substantial work with
  no issue gets one filed *first*); `get_task` and read the **Definition of
  Done**, which is the standard the work is judged against — never infer one
  from the description; `pick_up_task` before the first edit, not after the last.
- **As you work,** each of these requires a write: you meet a criterion →
  `update_criteria` `tick`, that one, right then; the approach changes →
  `add_note`; you are blocked or stopping → `add_note` with where it stands and
  what is next; the work uncovers a condition the issue never anticipated →
  `update_criteria` `add` (never to describe what you happened to do).
- **Tick criteria one at a time, never in a batch at the end.** A half-finished
  issue that says *which* half is worth far more than one claiming nothing. If
  every criterion is still unticked when you close, you worked it wrong.
- **Never end a work session with the issue out of date.** Twenty minutes of
  edits the tracker knows nothing about is the failure, not a tidiness lapse.
- **Finishing:** tick what is genuinely met, then `close_task` **with a
  resolution** — always `close_task`, never `update_task` to a closed state, so
  the resolution is recorded and the fix is findable next time. Not actually
  done? Do not close it: move it to review or blocked and note what remains.

**Filing — an issue is one self-contained feature, bug, or objective, with
enough substance that someone could pick it up cold.** Prefer *few and meaty*
over *many and thin*.

- **Substantial by default.** A five-minute change or a single step of something
  larger is a sub-task, a checklist entry, or a note — not its own issue.
- **Span as few issues as possible.** One substantial issue with sub-tasks before
  several thin ones. Splitting is the exception you justify.
- **Three sizes:** a sub-task is a step of one issue, an issue is one contained
  objective, a **project** is an objective that needs several issues. When work
  is too big for one issue it goes *up* into a project, never sideways into loose
  siblings. **The moment to open a project is the second issue** — `list_projects`
  first, reuse what exists, and pass `project` on both. Projects are few,
  long-lived and meaningful: never one per work session, never one for a single
  issue. Issues that turn out to belong together can be gathered later with
  `update_task` and `project`.

**Before filing, stop at the first match:**

1. Part of an objective that already has an issue? `add_note` to it, or
   `create_task` with `parent` for a sub-task. Not a new top-level issue. A
   genuinely separate issue serving that objective belongs in the same `project`.
2. A passing observation or "we should look at this"? That's a note.
3. Can't state what "done" looks like? It's a note until you can.
4. A genuine, self-contained objective with a clear done? File it.

Always `search_tasks` first, including `COMPLETED` — it may already be fixed,
and you should reference or reopen that instead of duplicating it.

**A good issue has** a one-line title, a description of the problem and *where it
lives*, and acceptance criteria — concrete checks for "done", which become the
Definition of Done you tick off as you work. If you can't write them, the issue
isn't contained yet.

**Put the work on the map.** A project says which objective an issue serves; a
second axis says what the software is made of. A **product** is what the
workspace ships, a **module** is where the code is (a repository, a path in one,
a service), and a **capability** is what the software does for its users.

- **Read it before you file.** `list_modules` gives every module with the
  repositories it sits in — match that against the checkout you are in and you
  know what your work touches. `list_capabilities` says whether what you are
  about to describe already has a name.
- **Name the capability** on `create_task`. One, or none. Name the one that
  exists rather than restating it in your own words; nothing fitting is a fine
  answer and better than a near-miss.
- **Do not set the modules.** There is deliberately no field for them: modules
  are recorded by a person, or by the pull request that changes the code, at the
  one moment the answer is known rather than guessed.
- **Ask what will collide with you** before you start —
  `list_tasks(modules: ["server"], stateCategory: ["STARTED"])`, or
  `list_tasks(capability: "…")`. That is the question this axis exists to answer.
