# Knowledge gardener: progress

The running log for [PLAN.md](./PLAN.md). Keep it current while you work: the
next session starts by reading it.

## Status

- Current phase: 2, implemented and under review. Phase 1's review fixes and
  phase 2 ride PR #44; phase 3 joins it next.
- Pull requests: the maintainer asked for the remaining phases in two or three
  pull requests rather than one each. PR #44 carries phase 1's review fixes,
  phase 2 and phase 3; a second carries phases 4 and 5; a third phases 6
  and 7.
- Last verify: `KNOWLEDGE-GARDENER VERIFY: FAIL phases 0-2 spec-hash 069a84bf6612`
  (21/23; server 1421, agent-core 63, cli 10, webapp 616 tests; typecheck ok).
  KG-2.1 fails on a checklist path that no longer exists (see Needs a
  decision); KG-2.R waits on the review.

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

### Phase 1

- **Scope resolution (KG-1.2)** lives in `modules/module-routing.ts` beside
  the pull-request routing and reuses its prefix normalisation and
  `pathBelongsToModule`:
  - `scopePath` reads the folder a scope names: `./` and slashes trimmed,
    everything from the first glob segment dropped; a bare pattern names
    nothing.
  - A scope matches a module whose folder it is in or is, and a module whose
    folder is below it. A fact about `apps` reaches every module under `apps`.
  - A whole-repository module (no prefixes) matches only when that is
    unambiguous: the scope starts with the repository's full name, or the
    workspace has one repository. Otherwise a path in a workspace with two
    small repositories would land in both.
- **When entry modules are recomputed:** on create, on a scope change, for a
  whole workspace whenever `ModulesService` changes a module's repositories or
  deletes a module (a `recomputeEntryModules` job on the `pages` queue, which
  `ModulesModule` now registers), and once at boot for every workspace
  (`EntryModulesScheduler`, kept apart from the decay scheduler so its tests
  stand). The boot pass also fills in entries written before this phase.
  Requests are folded per workspace in five-second windows
  (`recomputeModulesJobOptions`): one job id per window, run once the window
  closes plus a one-second grace for servers whose clocks disagree. A burst
  of edits, or replicas booting together, queue one pass, and no request can
  land while its own pass is already running and be dropped, which a fixed
  job id would allow.
- **Typesense:** four new faceted fields: `scopePath`, `scopeAncestors`,
  `moduleIds`, and `entryKind` (not `kind`, which already means page or
  entry). They are in `requiredPageFields`, so an existing collection is
  dropped and rebuilt from Postgres on the next boot, by the path that
  already existed.
- **Prefix matching (KG-1.3):** a scoped search matches knowledge whose scope
  path is the query folder or above it, whose ancestors include the query
  folder (below it), or that is unscoped. With a scope, the `_eval` tier
  comes before text match, so every scoped match outranks unscoped knowledge,
  as the criterion requires. Without a scope or seeds, the ranking is exactly
  what it was.
- **Ranking tiers:** Typesense allows three sort fields and scores `_eval` by
  the best tier a document matches, not a sum (typesense#2014). Each tier is
  therefore a conjunction of positive conditions (scoped, seed or neighbour
  module, verified), scored by how much it matches and listed best first.
  With seeds and a real question, text match is bucketed (`buckets: 10`)
  first, so a boost reorders near-equal answers without burying a far better
  one.
- **Seeds (KG-1.5):**
  - The strong seeds are the named modules and the issue's modules.
  - The neighbours are the modules of any capability that lists a seed (or is
    the issue's capability), and the modules owned by or linked to a seed's
    product.
  - Every id is checked against the workspace and against deletion,
    including the module lists on capabilities, which are plain ids rather
    than a relation.
  - Page bodies are not boosted, because page documents carry no modules.
    Indexing the modules a page is linked to would do it, and is left for a
    later phase.
- **Kind (KG-1.4):** a column defaulting to FACT, so nothing is written for
  the default. Agents may change the kind of their own untriaged entries.
  `recall_knowledge` takes `kinds`; the CLI has `--kind` on `append` and
  `search`, plus `--module` and `--issue` on `search` and `context`. The CLI
  package's jest setup cannot load `commands/knowledge.ts` (chalk is
  ESM-only), so its flags are covered through agent-core, which they pass
  straight to.
- **Webapp (KG-1.6):**
  - A product's screen shows the knowledge of the modules it owns, not those
    merely linked to it; a design system linked to three products would
    otherwise fill all three.
  - Entries come from `GET /page_entries?status=STANDING&moduleIds=…&limit=50`,
    because the synced store loads entries a page at a time. The list endpoint
    gained an optional `limit`; the screen says when it has hit it.
  - The page view's Related section can link to products, modules and
    capabilities and routes to them, through one `linkRoute` function.
  - The synced store keeps `kind` and `moduleIds`, as the sync contract
    requires.
- **Test method:** `vector/knowledge-search.spec.ts` builds documents and
  requests with the real service and applies them with a small evaluator of
  the filter subset the service writes. That lets it assert which entries
  come back, and in what order, without a running Typesense. It models
  `_text_match(buckets: N)` the way Typesense applies it (blocks of
  floor(results / N) take their first document's score; nothing is bucketed
  below N results). Each behaviour was mutation-checked: the test fails when
  the behaviour is broken.
- **Formatting:** running Prettier on files this phase changed also
  normalised a few pre-existing lines in them (`page-links.service.ts`,
  `agent.spec.ts`).

### Phase 2

- **Model (KG-2.1).** `PageEntryCitation` follows the plan's shape, plus
  `targetLabel` (an issue key or pull request URL, so served proof reads
  without a second lookup) and, for CHANGED checks only, `judgment`,
  `judgeModel`, `judgeLines` and `judgeReason`. Hand-written migration
  `20260927010000_knowledge_citations`: a new table and three enums, no
  existing row touched.
- **Input.** `citations` (at most 10) on the create route, `remember`,
  agent-core's `remember` and the CLI. One citation names exactly one of
  `path` + `lines` (with optional `sha` and `repo`), `issue`, `pullRequest`,
  `comment` or `run`; naming none or two refuses it.
  - `sha` is optional and defaults to the head of the default branch, so a
    writer that knows no commit can still cite.
  - `quote` is optional: when given it must appear in the cited lines, or the
    write is refused. It is never served and never the snippet, which is
    always what the server read. When the source is unreachable at write, the
    quote is kept (`pendingQuote`) and checked when the retry reads the
    lines, then cleared (review round 1).
  - `repo` picks among the workspace's module repositories when the path
    alone is ambiguous; otherwise the repository is the one whose modules
    the path belongs to, or the only one.
  - Citations are accepted on create only. Changing what an entry rests on is
    a new claim, which goes through a superseding entry and review.
  - The CLI takes `--cite path:lines[@sha]`, `issue:ENG-42`, `pr:<url or id>`,
    `comment:<uuid>`, `run:<uuid>`, or a JSON object, repeatable.
- **Checking at write (KG-2.2).** Every citation is checked before anything
  is stored. One that fails answers `422 { status: 'citation-failed',
  citation: <1-based position>, message }` and nothing is written.
  agent-core relays that as a `citation-failed` result, the CLI prints it,
  and `remember` returns it to the agent. A commit the repository does not
  have counts as missing, so the write is refused rather than stored as
  unknown, and so does a folder: there is no file there to cite. A written
  or edited entry comes back with its proof, so the writer sees what each
  citation came to, including any left unread.
- **Unreachable sources (KG-2.3).** A repository that does not answer gives
  UNKNOWN, and the write goes ahead: the server failing to read the code is
  not evidence against the claim. A `retryUnknownCitations` job on the
  `pages` queue retries the entry: one job per entry (fixed job id), six
  attempts with exponential backoff from five minutes, about five hours in
  all. When the retry reads it, what the write would have refused (no file,
  lines past the end, a quote not in the lines) becomes MISSING with no
  snippet, so no later check can turn it into a citation that holds. A
  citation still unread when the retries run out is read by the next
  re-check. A re-check that cannot reach the source keeps the last result
  instead of replacing it with UNKNOWN. A citation whose repository row is
  gone (its module deleted, or the repository moved to another module) is
  moved to a live row for the same repository in the workspace and checked
  there; only a repository no module lists any more makes its citations
  MISSING, in the retry and the re-check alike.
- **Sources.** `RepoFileSourceService` chooses by the integration behind
  `ModuleRepo.integrationAccountId`, checked against the workspace:
  - GitHub: the JSON contents API with the installation token alone
    (`READ_REPO_FILE` and `RESOLVE_REPO_HEAD` integration events), so the
    person's OAuth token is never refreshed for a citation. The JSON form,
    not the raw one, because only it says whether the path is a file; a
    folder, symlink or submodule is missing. Files over 1 MB are unknown,
    not missing.
  - Local-repo: `git cat-file blob <sha>:<path>` (which, unlike `git show`,
    refuses a folder) and `git rev-parse` in the configured checkout, with
    the path normalised and refused if it leaves the repository or has a `.`
    segment, and only hexadecimal commit ids passed to git.
  - Every call to a source has a 10-second timeout, and a whole read (token,
    file, and the check that a 404 came from the repository) is unread after
    15 seconds, since a write waits on it.
  - Within one write or check, each repository's head is resolved once, and
    a repository that does not answer is not asked again: the rest of its
    citations are unread at once. A file unread for its own reason (too
    large) does not stop the others.
  - An integration that throws, rejects or answers something malformed gives
    UNKNOWN, never MISSING, and never fails the write.
    `IntegrationsService.loadIntegration` does not catch an async plugin's
    rejection, so the file source catches it itself.
- **Relocation (KG-2.4)** compares whitespace-normalised text, with a sha256
  of the snippet stored beside it. The snippet at its lines is HOLDS; found
  elsewhere is MOVED, taking the occurrence nearest the old lines and storing
  the new range; not found is CHANGED; the file gone is MISSING. No model is
  involved.
- **Re-checks** (`EntryCitationsService.recheck`) compare against the head of
  the default branch and update the index when a result changes. Phase 3's
  harmful-outcome signal and phase 6's merged pull requests call it; phase 2
  only retries UNKNOWN.
- **Judge (KG-2.5).** Only CHANGED goes to a model, with the claim, the old
  snippet and 20 lines either side of the old location. It answers holds,
  contradicted or unclear, with the lines it relied on and a reason. The role
  is `smart` unless the writer's model (from the `AgentRun` its session
  belongs to) is the `smart` model, in which case `fast`. The model used is
  stored. With no model configured, or an answer that does not parse, the
  judgment is UNCLEAR. The prompt is inline in `citation-judge.ts`.
- **Non-code citations (KG-2.6)** are found through Prisma in the writer's
  workspace: an issue by key or id, a pull request by id or URL through the
  issue's links, a comment and a run by id. Deleted and foreign targets fail
  the citation.
- **Trust (KG-2.7)** is derived, never stored: `verifiedAt` set →
  HUMAN_VERIFIED; STANDING with at least one citation and every one HOLDS or
  MOVED → GROUNDED; everything else UNGROUNDED. That includes a CHANGED
  citation the judge thinks still holds: that is an opinion, not a check. It
  also includes an entry with an UNKNOWN citation: unread never refuses a
  write or counts as a failed check, but it has not been checked, and the
  criterion says every citation holds. Page bodies carry no tier.
- **Ranking.** `trust` is a new Typesense facet in `requiredPageFields`, so
  an existing collection is rebuilt from Postgres on boot. The `_eval` tiers
  are verified, then grounded, then the rest, inside the scope and module
  tiers from phase 1 (multiplied, since `_eval` scores the best matching
  tier). Without a scope the default sort is text match, then trust, then
  retrieval count.
- **Served proof (KG-2.8).** `knowledge-proof.ts` is the one serializer:
  trust, each citation with its last result, time and commit (the judgment
  only for CHANGED), the latest check of any citation, and the commit of the
  latest code check (an issue or run is checked at no commit). Search hits,
  recall, the entry list, a written or edited entry, `load_context`, MCP,
  agent-core and the CLI (hits, entry tables, `append`) use it. Proof comes from
  Postgres after the search, not from the index, so it is never staler than
  the last check. The run context pack's knowledge items are typed with the
  proof and rendered with one line of prose each (`describeProof`); the pack
  is still empty until phase 3 (KG-3.2) fills it. The context pack's token
  budget counts the proof.
- **Skill moved on `main`.** The guides moved from `apps/docs/skills/` to
  `skills/` (e7b9c44). The citation guidance is in
  `skills/working-vantik-knowledge/SKILL.md` and the always-in-context form.
  PLAN.md's orientation row now points there. KG-2.1's file check still names
  the old path; see Needs a decision.

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

### Phase 0, round 4 (same reviewer, fixes plus a final pass over the phase)

`VERDICT: NO UNRESOLVED FINDINGS`. Two non-blocking notes, both fixed in the
wording commit after `001c875`:

1. The refusal for a CONSOLIDATED target told agents to correct the page body,
   which for an agent means the unreviewed `write_page`/`consolidate_knowledge`
   routes. It now says to write a plain new entry, which goes to review; the
   skill says the same.
2. The chain-walk comment said an archived link was one "a person archived";
   decay expiry and an agent withdrawing its own entry also archive. Reworded.

Phase 0 review: PASS - four rounds by one fresh reviewer subagent over the
phase diff against PLAN.md and the KG-0 criteria: agent triage refused on
single and bulk routes, corrections retire nothing until a person accepts them
(chains, disputes, archives, displacement and batch order checked against a
stateful double and the reviewer's own stricter fake), server-side duplicate
check on every client, read scope on load_context, settled search, decay from
lastServedAt; no skipped or loosened tests, checklist and verifier untouched.

When a phase's independent review ends with no unresolved findings, add a line
in the form `Phase <number> review: PASS - <what the reviewer checked>`, for
example with the number 0 for phase 0. `verify.mjs` looks for that line.

### Phase 1, round 1 (fresh reviewer subagent)

`VERDICT: NO UNRESOLVED FINDINGS`, with six non-blocking findings. All six
were fixed rather than left, and the fixes went back to the same reviewer:

1. `KnowledgeService.search` passing `kinds` and seeds on was untested.
   Tested now (`knowledge.service.spec.ts`); dropping either fails it.
2. A doc comment sat on the wrong handler in `pages.processor.ts`. Moved.
3. The product-axis "standing only" filter was an untested inline URL, and
   the list had no limit. Now built by `moduleKnowledgeUrl` (tested), capped
   at 50 through a new optional `limit` on `GET /page_entries` (tested at the
   controller and the service).
4. The "boost with a question" test matched a string. The evaluator now
   models bucketing, and the test asserts the order: a boosted answer
   overtakes its bucket-mate but not a better bucket. Mutation-checked with
   the string assertion removed.
5. Neighbours from `capability.moduleIds` were not checked against the
   workspace, though this log said every id was. They are now, with a
   foreign and a deleted module in the fixture.
6. Recompute jobs were never deduplicated. Folded per workspace in
   five-second windows (see Decisions); tested.

The reviewer also corrected the recorded reason the CLI has no tests (its
jest cannot load chalk's ESM, not a missing TypeScript transform). Fixed
above.

### Phase 1, round 2 (same reviewer, on the round 1 fixes)

`VERDICT: NO UNRESOLVED FINDINGS`. All six fixes confirmed, each by mutation,
and the folding argument checked against Bull 4.16.5's source (`addJob`
ignores an id that exists in any state; the run time is the adder's clock
plus the delay; the edit is committed before the window is read). One
non-blocking note, fixed: the window comes from the adding server's clock and
the worker promotes by its own, so the "never dropped" claim assumed agreeing
clocks. The delay now runs a one-second grace past the window's end, which
covers any smaller skew, and the comment says so.

Phase 1 review: PASS - two rounds by one fresh reviewer subagent over the
phase diff against PLAN.md and the KG-1 criteria: link resolution for
products, modules and capabilities; scope-to-module resolution on every
writer (entries, repository edits, module deletion, boot) with folded
recompute jobs; prefix-matched scoped search ranked above unscoped knowledge;
entry kinds end to end; one-hop seeding checked against the workspace and
deletion; product-axis screens showing standing entries only, capped; the
search evaluator matching Typesense's filter, `_eval` and bucketing
semantics; mutation checks on each; no skipped or loosened tests, checklist
and verifier untouched.

### Phase 2, round 1 (fresh reviewer subagent)

2 blocking, 11 non-blocking findings, and the Needs-a-decision entry
confirmed accurate. The reviewer mutation-checked 17 behaviours (each caught
by a tagged test), matched the migration against `prisma migrate diff`, and
checked workspace isolation and injection. All findings fixed; each new test
was mutation-checked:

1. **Blocking: an unreachable GitHub failed the write with a 500.**
   `loadIntegration` returns an async plugin's promise without awaiting it,
   so a token refresh that cannot reach GitHub rejected through it, and the
   test's double (resolving undefined) hid that. The file source now catches
   any throw or rejection as UNKNOWN; tested through a rejecting integration,
   and through `checkForWrite` with the real file source.
2. **Blocking: `remember` returned the entry with no proof.** Create and
   update now return the entry with its citations and proof; tagged tests on
   the service, agent-core and the MCP `remember` result.
3. **The last-checked commit was lost when a non-code citation was checked
   last.** It is now the latest code check's; the proof test that encoded the
   old behaviour asserts the new one.
4. **A folder could be cited and hold.** git reads with `cat-file blob`;
   GitHub through the JSON contents API, where a folder, symlink or submodule
   is missing; `.` path segments refused. Tested with real git and stubbed
   GitHub answers.
5. **No timeouts on the write path.** 10 seconds on every GitHub call and on
   git; a killed git answers "took too long".
6. **A citation unread after the retries was never read again.** Re-checks
   now read it at its own commit.
7. **UNKNOWN does count against trust.** Kept, as the criterion says every
   citation holds; the comment and this log now say so.
8. **A removed repository was handled two ways.** MISSING in both the retry
   and the re-check.
9. **A quote was not checked when the write could not read the code.** Kept
   as `pendingQuote` (new migration `20260927020000_citation_pending_quote`)
   and checked by the retry; a mismatch is MISSING with no snippet.
10. **The judge could be shown no code** when the file shrank past the old
    lines. The region is clamped to the end of the file.
11. **CLI entry tables showed trust only.** Each entry's proof is listed
    beneath the table, and `append` prints what its citations came to.
12. **Too many GitHub calls per write.** The installation token alone (no
    OAuth refresh), and each repository's head resolved once per write or
    check.
13. **Skill text.** GROUNDED now says accepted and every citation read and
    holding, in both guides and the `remember` description; the unreachable
    case says the citation is UNKNOWN until read.

### Phase 2, round 2 (same reviewer, on the round 1 fixes)

`VERDICT: NO UNRESOLVED FINDINGS`. Every round 1 fix confirmed by
mutation, the new migration matched with `prisma migrate diff`, and
`pendingQuote` confirmed never served. Three non-blocking findings, all
fixed, each new test mutation-checked:

1. **The installation-token request had no timeout**, so a GitHub that
   swallowed connections held a read for minutes before the 10-second
   timeouts were reached. Each read and head in the file source is now
   bounded as a whole (15 seconds), which covers the token, the file, the
   404 check and any plugin.
2. **A slow repository was asked once per citation.** Within a write or
   check, a repository that does not answer is not asked again; a file
   unread for its own reason (`thisFileOnly`: too large, or not a path a
   source may be asked for) does not count against it.
3. **A deleted repository row made citations MISSING although the repository
   was still in the workspace** (a module deleted, or the repository moved
   between modules). The citation moves to the live row for the same
   repository and is checked there.

The reviewer's minor note (a re-check rewrites `checkedAt` and re-indexes
when nothing changed) is left: `checkedAt` records that a check happened,
and the index write is idempotent.

## Needs a decision

Anything that blocks the plan: a criterion that is wrong or cannot be met, or
an environment problem such as Prisma being unable to download its engines.
Give the evidence, and stop until the maintainer answers.

- **KG-2.1's file check names a path `main` removed.** The check is
  `{ "type": "file", "path": "apps/docs/skills/working-vantik-knowledge/SKILL.md", "pattern": "[Cc]itation" }`.
  `main`'s e7b9c44 ("Move the agent guides to skills/, so `npx skills add
  cmunte132/vantik` works") moved the guides to
  `skills/working-vantik-knowledge/SKILL.md`, and the server now serves them
  from there. That file carries the citation guidance and matches the
  pattern. Recreating the old path would pass the check without meaning
  anything, and this session may not edit `checklist.json`.
  **Proposed fix (maintainer):** change that path in `checklist.json` to
  `skills/working-vantik-knowledge/SKILL.md`, and put the new spec hash that
  `verify.mjs` prints into GOAL.md. Nothing else in phase 2 depends on it.
  KG-7's `apps/docs/docs/fundamentals/knowledge.mdx` check is unaffected:
  that file is created in phase 7 and the path is still valid.

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
- **`IntegrationsService.loadIntegration` does not catch async plugin
  failures.** It returns `integrationModule.default(payload, ctx)` inside a
  `try` without `await`, so the `catch` (which logs and returns undefined)
  never sees a rejected promise; every caller gets the rejection instead.
  Phase 2's file source now guards itself. Other callers may rely on either
  behaviour, so changing it is a separate fix.
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
- 2026-09-26: Review round 4: no unresolved findings; two wording notes fixed.
  Phase 0 done.
- 2026-09-26: PR #43 opened for the plan and phase 0. Phase 1 implemented
  (KG-1.1 to KG-1.6) with tagged tests. Verify through phase 1: 13/14, all
  suites and typecheck green.
- 2026-09-27: PR #43 merged with phase 1's implementation; the branch was
  restarted from `main` (a fast-forward). Review round 1: no unresolved
  findings; all six non-blocking findings fixed and sent back to the reviewer.
- 2026-09-27: Review round 2: no unresolved findings; the clock-skew note
  fixed with a grace on the recompute delay. Phase 1 done.
- 2026-09-27: Phase 1's review fixes opened as PR #44. Phase 2 implemented
  (KG-2.1 to KG-2.8) with tagged tests. The maintainer asked for the rest in
  two or three pull requests: phases 1 (fixes) to 3 in #44, 4 and 5 next,
  6 and 7 last. Verify through phase 2: 21/23, all suites and typecheck
  green. KG-2.1's file check names a path `main` moved; under Needs a
  decision.
- 2026-09-27: Phase 2 pushed to PR #44 (5f55146); CI green. Review round 1:
  two blocking findings (a 500 on an unreachable GitHub, no proof on a
  written entry) and eleven non-blocking; all fixed with tagged,
  mutation-checked tests.
- 2026-09-27: Review round 2: no unresolved findings; three non-blocking
  findings (a read bounded as a whole, a repository that stops answering
  asked once, citations following a moved repository) fixed.
