# Knowledge gardener: progress

The running log for [PLAN.md](./PLAN.md). Keep it current while you work: the
next session starts by reading it.

## Status

- Current phase: 0 (implementation done; independent review in progress)
- Last verify: `KNOWLEDGE-GARDENER VERIFY: FAIL phase 0 spec-hash 069a84bf6612`
  (KG-0.1 to KG-0.6 pass; KG-0.R waits on the review)

## Decisions

- **Signing-secret test made root-safe (outside the plan).**
  `apps/server/src/modules/attachments/url-signer.spec.ts` made its storage
  directory read-only and expected the write to fail. Root ignores permission
  bits, so in this sandbox (which runs as root) it failed with the code
  behaving correctly, and `verify.mjs` requires every test to pass. The test
  now puts a file where the storage directory has to be created, which fails
  the write for every user. The assertion is unchanged.
- **Merged `main`** (PR #38, tests only) before starting, so the phase is built
  and verified against current `main`.
- **KG-0.1: what an agent may change.** An agent may change only its own
  entries, only while they are PROPOSED, and only their content, scope or a
  move to ARCHIVED (withdrawing the claim). Promoting, disputing, verifying,
  consolidating through the update route, and editing someone else's or an
  already-triaged entry are refused with 403. Editing the text of a STANDING
  entry was a second route to unreviewed served knowledge, so it is closed
  too; the correction path is a superseding entry.
- **KG-0.2:** every bulk request is a triage decision, so an agent's bulk
  request is refused outright, before anything is read.
- **Consolidation checked (KG-0.1 note in the plan):** `POST /pages/:id/consolidate`
  folds only STANDING entries, so it cannot make a PROPOSED entry be served.
- **KG-0.3: two tiers.** An exact repeat (case and whitespace normalised) is
  refused for every writer. A near match from `VectorService.findSimilarEntries`
  (the search agent-core used to run) is also refused, except when a person
  writes a STANDING entry from the webapp, since they are the reviewer with
  the page open. If the index is unreachable, the near-match tier is skipped
  and logged, and the exact tier still holds. Both answer
  `409 { status: 'needs-decision', nearMatches, message }` unless the write
  passes `supersedesId` or the new `distinct: true`. agent-core's `remember`
  now posts directly and relays the 409 as its existing needs-decision result.
  The webapp's add-a-fact box now shows the server's refusal instead of
  failing silently.
- **KG-0.5:** the settling logic is `createSettledQuery` in
  `apps/webapp/src/modules/search/settled-query.ts`, driven by fake timers in
  its spec; the dialog uses it through `useSettledQuery`.
- **KG-0.6:** the standing pass archives an unverified STANDING entry created
  before the window when it was last served before the window, or never served
  (`lastServedAt` null and `retrievalCount` 0). A row with a count but no date
  predates `lastServedAt` being recorded and is spared.
- **Existing tests adjusted, not loosened:** the five status-transition tests
  named their writer `human-1` but built an agent (the fixture's default), so
  the new agent rule refused them; they now build a person. The decay test's
  `retrievalCount: 0` assertion encoded the rule KG-0.6 replaces; the new
  tagged decay tests check the replacement against sample rows.

## Phase reviews

When a phase's independent review ends with no unresolved findings, add a line
in the form `Phase <number> review: PASS - <what the reviewer checked>`, for
example with the number 0 for phase 0. `verify.mjs` looks for that line.

## Needs a decision

Anything that blocks the plan: a criterion that is wrong or cannot be met, or
an environment problem such as Prisma being unable to download its engines.
Give the evidence, and stop until the maintainer answers.

(Nothing blocking.)

## Observed, outside the current phase

- **LOCKED is enforced only on entry appends.** An agent can still rewrite a
  LOCKED page's body through `POST /pages/:id` or `POST /pages/:id/consolidate`
  (`pages.service.ts` checks no policy). Not in any phase's criteria; worth a
  separate fix.
- **Agent-written page bodies are served without review** (`write_page`,
  `consolidate_knowledge`). Phase 7 (KG-7.4) turns consolidation of an
  AUTHORED page into a proposal; `write_page` on a new page stays as designed.

## Log

- 2026-09-26: Target phase 0. Prisma engines reachable. Fixed the root-only
  test failure, merged `main`, implemented KG-0.1 to KG-0.6 with tagged tests.
  Verify through phase 0: 6/7, all suites and typecheck green.
