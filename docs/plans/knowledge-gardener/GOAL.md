# Running the knowledge gardener with `/goal`

`/goal` keeps Claude working until a condition holds. After each turn, a
small, fast model decides whether the condition is met. It reads only the
conversation and cannot open files or run commands, so the conditions below
make Claude print the evidence: the verifier's verdict line, the review line,
and git state. The detailed spec stays in [PLAN.md](./PLAN.md), because a goal
condition is limited to 4,000 characters.

**The spec hash `069a84bf6612`** is computed from `checklist.json` and
`verify.mjs`. If either file changes, the hash changes, and every condition
below stops being satisfiable until you update it here. That is deliberate:
a session cannot pass by editing the criteria or the checker.

## Before you start

1. **Get these files onto the branch the session starts from.** Merge them to
   `main`, or start the session on the branch that carries them.
2. **Let the environment reach `binaries.prisma.sh`.** Prisma downloads its
   engines from there, and the server tests and the typecheck need them. In
   Claude Code on the web: the environment menu in the session's title bar →
   Edit → Network access. Allow that domain, or pick a broader access level.
3. **Use auto mode or accept-edits,** so the session isn't waiting on
   per-tool prompts.

## Option A: one phase per session (recommended)

Paste the same text into a fresh session once per phase. Each run picks the
next unfinished phase from the verifier. A fresh session per phase keeps the
context small, which long-running agent work has found to reduce drift. Each
phase also ends in a reviewable set of commits.

```text
/goal Deliver the next phase of the knowledge gardener plan in docs/plans/knowledge-gardener/.

Start: read PLAN.md and PROGRESS.md in full, run `pnpm install`, run `node docs/plans/knowledge-gardener/verify.mjs`, and state one line "Target phase: P", where P is the lowest phase with a failing criterion. Work only on phase P, following PLAN.md section 1 exactly: tests tagged with criterion ids, an independent review by a fresh subagent before the phase is done, no edits to checklist.json or verify.mjs, PROGRESS.md kept current, small commits pushed to this session's branch.

The goal is met only when the final turn shows all of these as raw command output, not paraphrased:
1. `node docs/plans/knowledge-gardener/verify.mjs --through P` ends with a line starting `KNOWLEDGE-GARDENER VERIFY: PASS` that names phase P as the end of its range and contains `spec-hash 069a84bf6612`. A FAIL, a different hash, or "never a pass" in that line means not met.
2. `grep -n "Phase P review: PASS" docs/plans/knowledge-gardener/PROGRESS.md` (with P replaced by the number) prints a line, and the reviewer's final report, with no unresolved findings, appears earlier in the conversation.
3. `git diff origin/main...HEAD | grep -nE '^\+.*\b(it|test|describe)\.(skip|only|todo)\('` prints nothing.
4. `git status -sb` shows a clean working tree and no "ahead" count.

If Prisma cannot download its engines (403 from binaries.prisma.sh), or a criterion is wrong or cannot be met, write it under "Needs a decision" in PROGRESS.md, show that entry, and stop: judge that as impossible, not as met. Stop after 150 turns.
```

## Option B: every phase in one session

Use this when you want to set it going and come back later. It needs the same
setup, and it runs for a long time.

```text
/goal Deliver every phase (0 to 7) of the knowledge gardener plan in docs/plans/knowledge-gardener/.

Start: read PLAN.md and PROGRESS.md in full and run `pnpm install`. Then, for each phase in order: implement it following PLAN.md section 1 exactly (tests tagged with criterion ids, no edits to checklist.json or verify.mjs, PROGRESS.md kept current, small commits pushed to this session's branch); run `node docs/plans/knowledge-gardener/verify.mjs --through <phase>` until only the phase's review criterion fails; get an independent review from a fresh subagent and fix its findings; record "Phase <n> review: PASS" in PROGRESS.md; and show that phase's passing verdict line before starting the next phase.

The goal is met only when the final turn shows all of these as raw command output, not paraphrased:
1. `node docs/plans/knowledge-gardener/verify.mjs` ends with the line `KNOWLEDGE-GARDENER VERIFY: PASS phases 0-7 spec-hash 069a84bf6612`. Anything else in that line means not met.
2. `grep -cE '^[-* ]*Phase [0-7] review: PASS' docs/plans/knowledge-gardener/PROGRESS.md` prints 8, and a passing verdict line for each phase 0 to 7 appears earlier in the conversation.
3. `git diff origin/main...HEAD | grep -nE '^\+.*\b(it|test|describe)\.(skip|only|todo)\('` prints nothing.
4. `git status -sb` shows a clean working tree and no "ahead" count.

If Prisma cannot download its engines (403 from binaries.prisma.sh), or a criterion is wrong or cannot be met, write it under "Needs a decision" in PROGRESS.md, show that entry, and stop: judge that as impossible, not as met. Stop after 600 turns.
```

## What each part of the condition guards against

| Part | Guards against |
|---|---|
| The verifier's verdict line, with the hash | Declaring victory without evidence; editing the criteria or the checker; tests that exist but don't pass; breaking other tests; type errors |
| The `[KG-x.y]` tags | Criteria without a test that proves them |
| The independent review line | Tests that pass without exercising the behaviour; a separate judge catches what self-review misses |
| The skip/only/todo grep | Getting green by switching tests off |
| `git status` | Work that exists only in the sandbox and disappears with it |
| The "impossible" clause | Pushing through a broken environment or a wrong criterion instead of asking you |

## After each phase

- **Read the phase's decisions** in `PROGRESS.md` and the review summary.
- **Open a pull request** from the session's branch, or ask the session to.
  Add "and open a pull request for the phase" to the Start paragraph if you
  want that every time.
- **Phase 4 ships in shadow mode.** The triage loop records what it would
  have decided but changes nothing, until you set
  `KNOWLEDGE_AUTO_TRIAGE=on`. Compare its decisions with your own triage
  for a while before turning it on.
