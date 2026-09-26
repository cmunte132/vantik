# Knowledge gardener: progress

The running log for [PLAN.md](./PLAN.md). Keep it current while you work: the
next session starts by reading it.

## Status

- Current phase: 0 (review round 3 addressed; round 4 in progress)
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
  (`lastServedAt` null). An earlier draft also spared rows with a count and no
  date as "legacy"; the review showed both columns arrived in one migration and
  are written together, so that branch and its test were removed.
- **Supersede waits for acceptance (review rounds 1 and 2).** A correction
  used to retire its target immediately, whoever wrote it, and SUPERSEDED is
  terminal: an agent could take any accepted entry out of use for good. Now:
  - the target is retired when the correction is accepted: at once for a
    person writing STANDING, otherwise when a person moves the correction to
    STANDING or CONSOLIDATED, singly or in bulk;
  - accepting a correction retires the chain behind it (the target, and what
    that target corrected if it was itself unaccepted), stopping at SUPERSEDED
    or CONSOLIDATED, which are never touched;
  - rejecting or disputing a correction leaves its target in use and keeps the
    pointer, so a correction revived to STANDING later still retires it;
  - a new correction of an entry takes the unique pointer over from an earlier
    archived (rejected) one, in the same transaction;
  - a PROPOSED or DISPUTED correction refuses an agent's second correction of
    the same entry; a person writing standing knowledge displaces it, and it
    stays where it is as an ordinary claim;
  - the chain walk passes only through undecided (PROPOSED or DISPUTED)
    corrections, so accepting a correction of an archived claim does not undo
    the archive decision;
  - an entry folded into the page body (CONSOLIDATED) cannot be superseded; it
    is corrected in the body.

  This applies to a person's correction that lands PROPOSED too (the CLI
  without `--standing`): only standing knowledge retires what it replaces.
- **Existing tests adjusted, not loosened:** the five status-transition tests
  named their writer `human-1` but built an agent (the fixture's default), so
  the new agent rule refused them; they now build a person. The decay test's
  `retrievalCount: 0` assertion encoded the rule KG-0.6 replaces; the new
  tagged decay tests check the replacement against sample rows.

## Phase reviews

### Phase 0, round 1 (fresh reviewer subagent)

1 blocking, 6 non-blocking findings. Answers:

1. **Blocking: an agent could permanently retire any standing entry by
   superseding it.** Fixed in `eee2050` (see Decisions: supersede waits for
   acceptance), with tagged tests.
2. **Editing skips the duplicate check, and the wording overstated it.** The
   `distinct` flag is a sanctioned bypass under KG-0.3's own wording, and an
   agent editing its own PROPOSED entry into a repeat is no worse than
   `distinct`. The comment and SKILL.md now say the check is skipped with
   `supersedesId` or `distinct`.
3. **Two identical writes at the same moment both succeed.** Accepted as a
   known gap for phase 0: closing it needs a stored content hash with a
   uniqueness guarantee, which is KG-4.1's corroboration-by-hash. Recorded here
   for phase 4.
4. **The decay comment's premise was false.** Fixed: branch and test removed.
5. **KG-0.5's tests don't cover the dialog wiring.** Accepted: PLAN.md §1 tests
   webapp criteria through extracted logic, and the vitest setup cannot render
   the dialog. The wiring is two lines in `search-dialog.tsx`.
6. **Consolidate lets an agent serve its own prose and retire others' STANDING
   entries.** Already under "Observed" below; KG-7.4 (consolidation on an
   AUTHORED page becomes a proposal) is where it is closed. The note now says
   precisely that the entry's text, not the entry, can reach the body.
7. **The webapp showed an API instruction.** The refusal now opens with the
   entry already on the page and its status, which is the part a person can act
   on; the resend instructions follow for API clients.

### Phase 0, round 2 (same reviewer, on the round 1 fixes)

2 blocking, 3 non-blocking findings. Answers:

1. **Blocking: accepting a correction of a correction left the original served
   and locked.** Fixed in `73aa310`: acceptance retires the chain; a decided
   target refuses new corrections with "already superseded", never "waiting".
   Stateful test.
2. **Blocking: a disputed correction accepted later served both truths, and
   rejection erased the pointer.** Fixed in `73aa310`: pointers are kept
   through rejection and dispute and moved only when a new correction is
   written. Stateful test.
3. **A pending agent correction blocked a person's standing correction.**
   Fixed: a person's standing correction displaces it.
4. **Consolidation folds a STANDING target that has a pending correction.**
   Accepted for phase 0: if the correction is later accepted, the CONSOLIDATED
   row is left alone (decided states are never moved) and the body still
   carries the old text until someone edits it. Consolidation is reworked in
   KG-7.4; recorded under Observed.
5. **Test gaps (chains, disputed-then-accepted, decided targets, decay query
   shape).** Covered by the stateful correction tests; the decay pointer
   release no longer exists.

### Phase 0, round 3 (same reviewer, on the redesign)

1 blocking, 3 non-blocking findings. All four fixed in the commit after
`634413d`:

1. **Blocking: a disputed correction gave its pointer to an agent's new
   correction**, so accepting it later served both truths. A DISPUTED
   correction now counts as waiting; only a person's standing correction
   displaces it. Tested, and mutation-checked.
2. **The stateful double did not model transaction order.** Writes are now
   deferred until `$transaction` runs them in array order; the mixed batch
   (DISPUTED target with its correction, accepted together) is tested, and
   putting the retirement before the status write fails that test.
3. **`chainToRetire` walked through archived corrections.** It now passes only
   through PROPOSED or DISPUTED links. Tested.
4. **A CONSOLIDATED entry could be superseded.** Refused now, with a message
   pointing at the page body. Tested. (That the webapp does not show supersede
   links, which the reviewer also noted, predates this phase; recorded under
   Observed.)

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
  `consolidate_knowledge`). Consolidation also marks the page's STANDING
  entries CONSOLIDATED (terminal), so an agent can retire others' entries and
  have its own prose, which may repeat its PROPOSED entries' text, served in
  their place. Phase 7 (KG-7.4) turns consolidation of an AUTHORED page into a
  proposal; `write_page` on a new page stays as designed.
- **Concurrent identical writes** both pass the duplicate check (read, then
  write). KG-4.1's content hash is the place to add a uniqueness guarantee.
- **Consolidating an entry that has a pending correction** leaves the old text
  in the body if the correction is later accepted. For KG-7.4.
- **The webapp shows no supersede links** (nothing under
  `apps/webapp/src/modules` reads `supersedesId`), so a reviewer accepting a
  correction cannot see what it retires. Predates phase 0; worth surfacing in
  the review queue, which phase 5 reworks (KG-5.1).

## Log

- 2026-09-26: Target phase 0. Prisma engines reachable. Fixed the root-only
  test failure, merged `main`, implemented KG-0.1 to KG-0.6 with tagged tests.
  Verify through phase 0: 6/7, all suites and typecheck green.
- 2026-09-26: Review round 1: one blocking finding (supersede by an agent
  retired accepted entries). Fixed with deferred supersede; non-blocking
  findings answered above. Verify through phase 0: 6/7, all suites green.
- 2026-09-26: Review round 2: two blocking findings in the round 1 fix
  (chained corrections, pointer erased on dispute). Pointers now kept and moved
  only by a new correction; acceptance retires the chain. Stateful tests.
  Verify through phase 0: 6/7, all suites green.
- 2026-09-26: Review round 3: one blocking finding (disputed corrections gave
  up their pointer). Fixed with three non-blocking ones; the double now defers
  writes to the transaction. Verify through phase 0: 6/7, all suites green.
