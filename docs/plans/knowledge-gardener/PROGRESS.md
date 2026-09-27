# Knowledge gardener: progress

The running log for [PLAN.md](./PLAN.md). Keep it current while you work: the
next session starts by reading it.

## Status

- Current phase: 6, in progress: KG-6.1, KG-6.2 and KG-6.5 implemented
  and mutation-checked; KG-6.3 and KG-6.4 next, then the review. PR #45
  is open from this branch, so the phase 6 commits are in it too; its
  description says so.
  Phases 4 and 5 are in PR #45; phases 6 and 7 go in the third pull
  request.
- Pull requests: the maintainer asked for the remaining phases in two or three
  pull requests rather than one each. PR #44 carries phase 1's review fixes,
  phase 2 and phase 3; a second carries phases 4 and 5; a third phases 6
  and 7.
- Last verify: phases 0-5, PASS, 45/45 (server 1702, agent-core 67,
  cli 10, webapp 637; typecheck ok).
- Spec hash: `8409159da053` since KG-2.1's file check was moved to
  `skills/working-vantik-knowledge/SKILL.md` at the maintainer's request
  (the guides moved there on `main` in e7b9c44). GOAL.md carries the new
  hash.

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
  PLAN.md's orientation row now points there. KG-2.1's file check named the
  old path; the maintainer had it moved (see Status).

### Phase 3

- **Uses (KG-3.1).** A `PageEntryUse` row per entry per serve, written in
  the same transaction that bumps `retrievalCount` and `lastServedAt`. `via`
  is CONTEXT_PACK (packed into a run: the run and its agent user), RECALL
  (search) or LOAD_CONTEXT (the context pack route). The token comes from the
  request; the session from an `x-vantik-session` header, which agent-core
  sends when given a `sessionId` and the MCP loopback passes through from its
  caller. A header that is not printable ASCII of at most 200 characters is
  dropped, not stored. Since round 1, `recall_knowledge` and `load_context`
  also take a `session` argument, as `remember` does, which agent-core sends
  as that call's header; MCP clients that cannot set headers name the session
  that way. Both routes are documented in `connect-mcp.mdx`. agent-core
  holds a session to the server's rule before sending it, and drops one that
  breaks it (round 2): `fetch` refuses some header values outright, and a
  session is never worth losing a read over.
- **Run knowledge (KG-3.2).** `KnowledgeService.knowledgeForRun` packs, in
  order: the STANDING CONVENTION entries whose modules overlap the issue's
  (verified first, then newest; at most 25 read), which are not held to a
  trust tier because a person accepted each as how that module works; then
  the top K entries a seeded search on the issue title ranks, re-read from
  Postgres and kept only if GROUNDED or HUMAN_VERIFIED. One token budget
  covers both, conventions first; an item that does not fit is skipped and a
  smaller one after it can still go in. An index that cannot be reached
  leaves the conventions. The prompt line gains `· written YYYY-MM-DD` beside
  the proof.
- **Settings.** `pages/knowledge-settings.ts` is the one reader for
  `KNOWLEDGE_HOLDOUT_RATE` (0.1), `KNOWLEDGE_CONTEXT_TOP_K` (5) and
  `KNOWLEDGE_CONTEXT_TOKEN_BUDGET` (1500, capped at 20000), each overridable
  per workspace under `Workspace.preferences.knowledge` (`holdoutRate`,
  `contextTopK`, `contextTokenBudget`). A value that cannot be read (a stored
  string, a share above 1, a fraction of an entry) falls to the layer
  beneath. Documented in `.env.example` and declared in `turbo.json`. The
  preferences route accepts `knowledge` since round 1; before it, the global
  pipe's whitelist dropped the key and nothing could set the override.
- **Holdout (KG-3.3).** The arm is the first 32 bits of the sha256 of the
  run's id, as a fraction, against the rate: below is HOLDOUT. The id is
  chosen (`randomUUID`) before the pack is built, since whether it carries
  knowledge depends on it, and the arm is stored on `AgentRun.knowledgeArm`.
  Raising the rate only moves runs from treatment to holdout. A retry keeps
  its run's arm and pack. Hosted is the only executor, and its guest reaches
  only the model and the module repositories, so the pack is a run's only
  knowledge and the holdout is clean. An executor added later whose agent can
  call `recall` itself would leak knowledge into its holdout. Runs from before
  phase 3 have no arm and are left out of the comparison.
- **Run signals (KG-3.4).** When a run ends SUCCEEDED, NEEDS_REVIEW or FAILED
  (not CANCELED or EXPIRED, which say nothing about the work),
  `KnowledgeSignalsService.runFinished` reads its last pass, whose findings
  are the ones still standing, and the entries it was served (its
  `PageEntryUse` rows). An entry gets HARMFUL (weight 1) when a finding's
  evidence or a failing check's output names a file it cites (in the run's
  repository, or where either repository is unknown) or a path under its
  scope's folder; otherwise HELPFUL (1) when the last pass's checks passed
  and the reviewer accepted; otherwise nothing.
  - The hosted executor now stores, per pass, `accepted` and `failedChecks`
    (`label`, `command`, and the repository paths its output names, not the
    output). `evidencePaths` reads paths: the sandbox checkout prefix is
    stripped, absolute and `../` paths are dropped, dotted folders and
    dotfiles are read, at most 50 are kept, and the text is split into runs
    of path characters first so the pattern stays linear on long output.
  - Counts are weighted Floats, `helpfulCount` and `harmfulCount` on the
    entry. Each signal is a `PageEntrySignal` row unique per entry, run and
    source (RUN or PULL_REQUEST), so attributing a run twice counts once, and
    a changed outcome moves the counts by the difference.
  - A harmful signal queues `recheckEntryCitations` (one job per entry),
    which runs phase 2's re-check. Nothing archives or deletes on a signal.
  - Attribution runs after the terminal transition commits. A failure is
    logged per signal and never fails the transition.
- **Pull request signals (KG-3.5).** The GitHub plugin reports `closed` and
  `reopened` pull request events through a new `agentRuns` plugin capability,
  scoped to the plugin's workspace. Runs are matched by `result.prUrl` equal
  to the pull request's URL: "a merged pull request for a run's issue" is
  read as the run's own pull request, so one a person opened for the same
  issue credits nothing the run was handed. A pull request a person opened
  from a run's branch counts as the run's own (round 1): the plugin also
  reports the head branch, its repository and when it was opened, and the
  newest run in that repository that pushed that branch before then, and has
  no pull request of its own, is credited. Branches are reused across runs
  of one issue, hence the newest before the opening, and a run with its own
  pull request is never credited for another. Merged gives HELPFUL (1); closed
  without merging HARMFUL (0.5, weak) with a re-check; a reopen withdraws the
  pull request's signal. The run records `pullRequestOutcome` and
  `pullRequestClosedAt`. A held-out run records its outcome, for the merge
  rate, and gives no signal, having been served nothing. Pull requests from
  other integrations are not reported yet.
- **Comparison (KG-3.6).** `GET /api/v1/agent_runs/meta/knowledge-arms`
  (`?since=` an ISO date; members only, an agent token gets 403) summarises
  each arm over finished runs that have one: runs; verification pass rate
  over runs whose last pass ran checks; mean review passes over runs that
  reached a pass; mean cost over runs that reported one (a failed hosted run
  reports what it spent since round 1, so failing expensively is not left
  out); merge rate over
  decided pull requests, with the open ones counted apart. Every figure
  carries what it was measured over. Settings → Agents has a "Does knowledge
  help?" section with both arms, the rate in force, and a warning while the
  smaller arm has fewer than 30 finished runs.
- **Migration** `20260927030000_knowledge_uses_and_outcomes`, hand-written
  from `prisma migrate diff` between the old and new schema: two tables, five
  enums, new nullable or defaulted columns, no existing row touched. No
  Postgres could be started in this sandbox; CI's `migrate:check` replays it.
- **Webapp sync contract.** The new AgentRun and PageEntry columns are listed
  as not kept, with reasons: the arm and outcome are read per arm from the
  endpoint, and nothing shows the counts yet.

### Phase 4

- **The pipeline (KG-4.3).** `pages/triage/knowledge-triage.service.ts`, one
  pass per entry on the `pages` queue (`triageEntry:<entryId>`, three
  attempts with backoff). `createEntry` queues it for every entry that lands
  PROPOSED; a person's STANDING write is already triaged and queues nothing.
  A queue that refuses the job leaves the entry in the inbox, as before. The
  pass skips an entry that is gone, no longer PROPOSED, already decided about
  (one decision per entry), or whose workspace has triage off. Stages, in
  order: policy, exact repeat, near neighbours, grounding, decision.
- **Policy (KG-4.8).** `triage/triage-policy.ts`. A credential pattern (key
  armour, provider key prefixes with their lengths, a password in a URL, a
  JWT, a Vantik token) rejects with policy SECRET before any model or the
  index sees the content, and the decision records the pattern's name, never
  the content. A list of two or more items, or over 1000 characters, rejects
  with ONE_FACT. Credentials are also refused at write (422
  `secret-refused`, content not echoed) on create and on edit, for a person
  too: entries are replicated to every member's browser, so triage finding
  one afterwards is too late. **An agent's entry is never accepted without
  a person, for now.** Runs do not write with a credential of their own
  (ENG-84): every agent writes through an MCP, CLI or REST client that names
  its own session, and a run of the same agent open at the time may have
  nothing to do with the entry (a self-assigned issue starts a hosted run
  for that agent; a shared agent account has many). So nothing the server
  holds says what an agent read, and every entry not written by a person
  (an agent, a System account, or no user record) gets UNKNOWN_SOURCE, a
  new reason, when it would otherwise be accepted. It does not stop a
  repeat from being folded in: that puts no new claim in front of anyone,
  and at worst archives a copy. Once runs write with a run-bound credential
  the server stamps, a run can vouch for what it wrote, and this can be
  narrowed. Outside input can still be found, and only ever makes the
  decision stricter. The writer's runs, from the server's record (`AgentRun`
  rows in the workspace whose `agentUserId` is the writer, not deleted,
  created at or before the entry and not finished before it), and every
  issue or comment the entry cites, are read for it. An issue is outside
  input when an integration filed it (`sourceMetadata.type`), it is a
  support issue or on a support team, a non-PR linked issue carries a
  source type or syncs, or its thread holds a comment mirrored from outside
  (`sourceMetadata.type`) written before the entry, deleted or not, since
  the comment stays after the link goes. A cited comment is outside input by
  its own `sourceMetadata.type`. Any of these escalates with EXTERNAL_INPUT,
  which applies even to a repeat, so text known to come from outside cannot
  raise another entry's corroboration count. The session is recorded as
  given, for tracing, and decides nothing. A person's entry is not read for
  runs.
- **Exact repeats (KG-4.1).** `PageEntry.contentHash` is sha256 of
  `normaliseContent`, written on create and on every content edit, and
  backfilled by the migration in SQL. The neighbourhood is PROPOSED and
  STANDING entries, not deleted, in the same workspace, sharing a module
  (`moduleIds hasSome`), or on the same page when the entry has no modules;
  and only entries written before it, ordered by `createdAt` then `id`, so of
  two identical entries written at once exactly one corroborates the other.
  A repeat corroborates the STANDING match if there is one, else the oldest.
  In `on` mode the target's `corroborationCount` goes up by one and the
  repeat is ARCHIVED, so no second row is ever served; a DUPLICATE relation
  (decided by HASH) from the repeat records who said it again and when.
- **Near neighbours (KG-4.2).** `VectorService.findNearEntries` asks the
  index for PROPOSED and STANDING entries in the entry's modules (a new
  `moduleIds` filter) or on its page, with the similarity threshold as the
  vector distance ceiling, and keeps only hits the embedding matched at or
  above it. Postgres then narrows them to the neighbourhood above, and the
  nearest three are compared. `KNOWLEDGE_SIMILARITY_THRESHOLD` (0.25, i.e.
  distance 0.75, the write-time near-match distance; overridable per
  workspace as `similarityThreshold`) is deliberately loose, since the
  vector distance is not calibrated (`SIMILARITY_MEASUREMENT_NOTE`) and at
  most three pairs are asked about. For each pair, `relation-guard.ts`
  first: a different number, month or weekday, negation parity or set of
  condition words makes it DISTINCT (decided by RULE) with no model asked.
  Otherwise two judgments classify it; only two readable, identical answers
  are a relation (decided by MODEL). Anything else is stored as DISTINCT and
  escalates with JUDGES_DISAGREE, so two unreadable answers never count as
  agreeing. An agreed DUPLICATE corroborates as an exact repeat does.
  Relations are upserted rows (`@@unique([fromId, toId])`); no entry's text
  is changed. An index that cannot be asked fails the pass, which Bull
  retries: a pass that cannot look for contradictions does not decide.
- **Two judgments (KG-4.4).** `triage/triage-judges.ts`: the `fast` and
  `smart` roles at temperature 0, or, when both roles resolve to the same
  model id, `smart` twice at 0.7. Prompts treat the entries as data, not
  instructions. The acceptance judgment is shown the claim and each
  citation as the server read it: path, lines, result and snippet; a cited
  issue's title and description or a comment's body, as plain text, in this
  workspace only, cut to 1500 characters; for a pull request or a run, its
  label and that its text is not shown. Any credential in what a model is
  shown (a neighbour's content, a snippet, a cited text) is replaced by
  `[withheld: <kind>]`, redacted before any cut. Plain text rather than
  markdown, because markdown escapes a token's underscores and an escaped
  token no longer matches. An answer that cannot be read, or a model that
  cannot be reached, counts as not accepting.
- **Auto-accept conditions (KG-4.4).** Reasons are collected, every one that
  applies: EXTERNAL_INPUT; SUPERSEDE_REQUEST (added to the plan's list: a
  declared correction retires accepted knowledge only on a person's
  acceptance, as phase 0 decided); CONTRADICTS_VERIFIED and
  CONTRADICTS_LOCKED for an agreed CONTRADICTS or SUPERSEDES against a
  verified entry or one on a LOCKED page; JUDGES_DISAGREE; NO_LLM; and, for
  an entry that is not a repeat, UNGROUNDED (no citations), CITATION_FAILED
  (any citation not HOLDS or MOVED, UNKNOWN included), UNKNOWN_SOURCE (not
  written by a person, as above), PIN_REQUEST (every
  CONVENTION, since standing conventions are packed into every run in their
  modules), BROAD_SCOPE (more than three modules, or no scope, since an
  unscoped entry is served to every query). The acceptance judgment
  is asked only when no reason applies. Decision: a broken policy rejects;
  any reason escalates; else a repeat corroborates; else it is accepted.
  HARMFUL_SIGNAL and AUDIT are in the enum for phase 5.
- **Precedence (KG-4.6).** `triage/precedence.ts`: HUMAN_VERIFIED over
  GROUNDED over UNGROUNDED, then the newer. The new entry is ranked as it
  would stand if accepted (STANDING with its citations). The relation stores
  `preferredId`. When an accepted entry wins against a STANDING one in `on`
  mode, that one becomes DISPUTED (reversible, withheld until a person
  looks), in the same transaction. Precedence can only rule against the new
  entry when a reason already escalates it (a verified neighbour, or the
  entry ungrounded), so nothing precedence ruled against is accepted. A
  PROPOSED entry it outranks is left for its own triage.
- **Shadow and on (KG-4.5).** `KNOWLEDGE_AUTO_TRIAGE` off | shadow | on,
  default shadow, per workspace as `autoTriage`, read through
  `knowledgeSettings`; the environment's value is read case-insensitively,
  a stored one only as written. Shadow records the decision and the
  relations and changes no status or count. `on` applies the decision in the
  transaction that records it: accept sets STANDING, a repeat or a reject
  sets ARCHIVED, an escalation changes nothing. Applying is conditional on
  everything it touches being as it was read: the entry PROPOSED with the
  `updatedAt` it was read with; the entry it repeats live, PROPOSED or
  STANDING, on a live page, with the same hash (an exact repeat) or content
  (a near duplicate); each entry it disputes STANDING, unverified, with the
  content it was compared with, on a page that is not LOCKED. Any of these
  failing throws inside the interactive transaction, which rolls back what
  was already changed; the decision and relations are then recorded in a
  second transaction with `applied: false` and `outputs.notApplied` saying
  which entry changed. Changed entries are re-indexed.
- **The record (KG-4.3).** `KnowledgeTriageDecision`: decision, reasons,
  policy, mode, applied, the corroborated entry, `inputs` (content hash,
  kind, scope, modules, citations and their results, the writer (user,
  type, session as given, each run with its model, issue and outside
  source, and whether the source was unknown), each cited issue or comment
  with its outside source, the threshold, the repeat found, each neighbour with
  its similarity, status, trust, relation and preferred entry),
  `inputsDigest` (sha256 of the inputs as sorted JSON), every model asked in
  order, and the judges' raw answers. The content is not copied into it.
  The human verdict column arrives with phase 5, which writes it.
- **No LLM (KG-4.7).** With none configured the policy, the hash, the rules
  and grounding still run; a pair that needed a model has no relation and
  adds NO_LLM, and so does an entry that reached the acceptance judgment.
- **Migration** `20260927040000_knowledge_triage`: `prisma migrate diff`'s
  output verbatim (two tables, six enums, two PageEntry columns and an
  index) plus the hash backfill. The backfill trims and folds with
  `regexp_replace` over JavaScript's `\s` spelled out as a class, not
  `btrim`'s character list (no `\v` escape in postgres, so it trimmed the
  letter v) nor postgres's `\s` (which follows the locale and leaves out
  U+00A0, U+2007, U+202F and U+FEFF). The class matches JavaScript's `\s`
  on every code point from 1 to 65535, checked on postgres 16. The
  migration's own UPDATE, run over 20 sample rows, agrees with
  `contentHashOf` on each: text starting or ending in v, tabs, vertical
  tabs, form feeds and newlines, no-break and ideographic spaces, accented
  and Japanese text. Lower-casing outside ASCII follows the database's
  locale; an entry where it differs from JavaScript's is not found by hash,
  and the near-match stage still compares it.
- **Webapp sync contract.** `contentHash` and `corroborationCount` are
  listed as not kept; nothing on screen reads them yet.

### Phase 5

- **Verdicts (KG-5.5).** `KnowledgeTriageDecision` gains `verdict`
  (ACCEPTED, REJECTED, EDITED), `agreed`, `verdictById` and `verdictAt`. A
  verdict is recorded when a person (never an agent) acts on an entry whose
  latest decision has none yet, and the entry was PROPOSED before the change
  or the decision was drawn for audit and the entry was still where it left
  it (review round 3). Setting STANDING or CONSOLIDATED is
  ACCEPTED; ARCHIVED or DISPUTED is REJECTED; changing the content, scope or
  kind (compared with what they were) is EDITED, whatever the status. Confirming
  alone gives no verdict: it says nothing about whether the entry stays.
  A person consolidating a page gives ACCEPTED on each audited entry folded
  into it, in the same transaction; an agent consolidating gives none.
  `updateEntry` and `bulkUpdate` put a conditional `updateMany` (`verdict:
  null`) in the same transaction as the change, so the verdict and the
  change commit together and of two people acting at once only the first
  gives one. Entries a person happens to act on later, not audited and no
  longer waiting, give none: they are not a sample of anything, and would
  tilt agreement towards whatever people go looking for.
- **What agreement rates (KG-5.3).** `triage/agreement.ts`, pure. Triage's
  label is its decision, or, for a decision held back by a back-off, the
  decision it reached (so a backed-off type can be seen to recover). An
  escalation is rated only when every reason is JUDGES_DISAGREE: every
  other reason is a rule that sends the entry to a person whatever they make
  of it, so a person accepting it does not say triage should have. A SECRET
  rejection is not rated: a credential is refused whatever agreement says.
  The person's decision: ACCEPTED is AUTO_ACCEPT; REJECTED agrees with a
  CORROBORATE or REJECT (taking it out of use is what those did), and is
  otherwise ESCALATE (triage has no way to drop an entry for being wrong);
  EDITED is ESCALATE (as written it was neither to keep nor to drop).
- **Kappa (KG-5.3).** Cohen's kappa per decision type, that type against
  the rest, over verdicts whose `verdictAt` is inside
  `KNOWLEDGE_KAPPA_WINDOW_DAYS` (30): the three acting types (AUTO_ACCEPT,
  CORROBORATE, REJECT), and ESCALATE, which is reported (whether what triage
  sent people needed them) but never backs off. Each verdict counts once.
  The report also gives the cells with each audit weighted by `1 /
  auditRate` (the rate recorded on the decision), which say how the
  verdicts stand for everything triage decided, for reading only: kappa
  over the weighted cells made acting so nearly universal that nineteen
  agreements in twenty audits came to 0.27 and backed acceptance off, and a
  type would stop and resume as audits entered and left the window (review
  round 2). A type's `samples` is
  the count of verdicts about it (triage decided it, or the verdict says it
  should have), unweighted, and is what the minimum is checked against.
  Verdicts on which neither side said it still enter its kappa, as the
  other class, but are no evidence about it: counted, they let a type pass
  the minimum on verdicts about the others (review round 1). With verdicts
  about the type, kappa is null only when both sides said it on every one,
  which back-off reads as complete agreement. Tested against hand-worked
  values (1, 0, 0.4, -1, a per-type table).
- **Audits (KG-5.2).** `KNOWLEDGE_AUDIT_RATE` (0.1, per workspace
  `auditRate`). The decision id is generated before the row is written, and
  the draw is the first 52 bits of sha256(id) over 2^52: seeded by the id,
  so whether a decision was audited can be worked out again from the id
  alone. Every applied acting decision is drawn (AUTO_ACCEPT, CORROBORATE,
  REJECT ONE_FACT), a superset of "auto-accepted", because in `on` mode a
  corroboration or a refusal never reaches a person otherwise and its kappa
  would never have samples. SECRET is never drawn: a person would be shown a
  credential. Shadow decisions are not drawn: they reach a person anyway.
  `auditRate` is recorded whenever the decision was drawable, for the
  weights. An open audit is listed while its entry is still in the status
  the decision left it (STANDING for an acceptance, ARCHIVED otherwise).
- **Answering an audit.** `POST /api/v1/knowledge/review/:decisionId/audit`
  `{agree}`. Agreeing keeps what triage did, not agreeing undoes it through
  the ordinary `updateEntry` (an acceptance is archived; a repeat or a
  refusal is put into use), and that change records the verdict like any
  other. 404 outside the workspace, 400 for a decision not drawn for audit,
  409 once it has a verdict. The answer's verdict write is strict (an
  `update` filtered on `verdict: null`, which fails when another verdict
  landed first and rolls back the answer's change with it), so two people
  answering at once cannot leave the entry as the second left it and the
  verdict as the first gave it; the second gets 409. Disagreeing with a
  folded repeat takes its corroboration back off the entry it repeated.
  Any other action on an audited entry (setting it aside from the rail,
  editing it, folding it into the page) gives the verdict too, while the
  entry is still where the decision left it: once decay, a person or a
  consolidation has moved it on, the audit is closed on every route, since
  acting on the entry then judges what moved it, not triage (review
  round 3).
- **Back-off (KG-5.4).** `KNOWLEDGE_KAPPA_FLOOR` (0.6) and
  `KNOWLEDGE_KAPPA_MIN_SAMPLES` (20), per workspace. A type with at least
  the minimum verdicts about it and a kappa under the floor backs off; a
  backed-off type resumes only with at least the minimum and a kappa at the
  floor or above. Under the minimum, or with none about it whatever the
  minimum, the state holds either way, so a type resumes on evidence, not
  on its verdicts ageing out of the window. State is the
  append-only `KnowledgeBackoffChange` table (the latest row per type),
  which is also the record of each change with the kappa, samples, floor,
  minimum and window it was made on, and each change is logged once
  committed. Re-evaluated after every verdict, inside a transaction holding
  a per-workspace advisory lock, so two verdicts landing together cannot
  both record the same change; a failure is logged and never fails the
  person's action. A backed-off decision (never a SECRET refusal) is
  recorded as ESCALATE with reason `LOW_AGREEMENT` and `backedOffFrom`, in
  shadow and in on, so it is still rated as what triage reached. Changing
  the floor or minimum takes effect at the next verdict.
- **The queue (KG-5.1).** `GET /api/v1/knowledge/review[?pageId][&reason]`:
  every PROPOSED entry, as the inbox always listed, each with the reasons of
  its open escalation; then the open audits, with reason AUDIT. Counts per
  reason are over the whole queue; `reason` narrows the items. With triage
  off it is the inbox alone, no reasons and no audits. The webapp keeps
  reading waiting entries from the synced store and takes reasons and audits
  from the endpoint, so the queue stays live and, until the endpoint
  answers, is exactly the inbox. Reason chips filter it; audits carry a
  question and two answers and are never selected in bulk. `GET
  /api/v1/knowledge/agreement` gives the kappa, counts, weighted counts and
  state per type, shown on Settings > Agents. All three routes refuse
  agents: an agent reads every entry through the knowledge routes, and is
  refused only the reviewer's view of why each was held back.
- **Migration** `20260927050000_knowledge_audit`: `prisma migrate diff`'s
  output (an enum, a value added to `KnowledgeEscalationReason`, seven
  columns, a table, two indexes). Replayed on postgres 16 over the earlier
  migrations; the diff against the schema is then empty. The new table is
  not replicated.

### Phase 6

- **Landed changes (KG-6.1).** `CodeChangeEvent` gains `mergeSha`: the
  merge commit of a pull request merged into the repository's default
  branch, or the new head of a push to that branch. A merge into any other
  branch has none: its code is not what agents are told about. A push is
  recognised by its shape (a `ref`, an `after` and a `commits` list, no
  `pull_request`), must be to `refs/heads/<default_branch>`, not a deletion,
  and its paths come from the commits' added, modified and removed lists
  (the head commit's when the list is empty); it names no issue keys, so
  routing is unchanged. `ModuleRoutingProcessor` routes keyed changes as
  before, and queues `recheckLandedChange` on the `pages` queue for any
  change with a `mergeSha` and paths, with the job id
  `recheckLandedChange:<workspace>:<repo>:<sha>`, so a merged pull request
  and the push of its merge commit queue one job while either is waiting.
- **Re-checking a landed change (KG-6.2).** `EntryCitationsService.recheckLanded`
  finds CODE citations by `(moduleRepoId, path)`: every module repository
  row with the change's `externalRepoId` in the workspace, deleted rows
  included (a citation keeps the row it was written against), and the
  changed paths, cleaned as citation paths are. Only live STANDING or
  PROPOSED entries, only citations that held once (they have a snippet), and
  not UNKNOWN ones, which their retry reads at the commit they cite.
  - **The commit read.** Each is read at the head of the default branch,
    not at the merge SHA itself. The head contains the change, and is the
    merge SHA unless more has landed since; jobs run on several workers and
    not always in the order changes landed, so reading an older commit than
    the newest could put back a result a later change had already
    corrected. The merge SHA names the job, is cited in the evidence, and
    skips a citation already checked at it. Also skipped: a citation checked
    since the job was queued (Bull's `job.timestamp`), since any check since
    then read a head containing the change. That makes the duplicate report
    and a retry read only what is left.
  - **Nothing is written by the check.** Each result comes back with what to
    store, and the upkeep stores it in the same transaction as what it does
    about it, so a crash cannot leave a result stored and not acted on
    (the retry would skip it). Unread citations fail the job after
    everything read was acted on; Bull retries with its backoff.
  - **What is done (`upkeep/knowledge-upkeep.service.ts`).** HOLDS and MOVED
    are stored (check time and sha; MOVED also the lines). For an entry in
    use: CHANGED with a CONTRADICTED judgment moves it to DISPUTED (a
    conditional `updateMany` on STANDING and unverified) with a
    `PageEntryMaintenance` row (DISPUTED, CITATION_CONTRADICTED, evidence:
    the change and each citation's path, lines, sha read and judgment) and a
    correction issue. MISSING gives an archive proposal
    (ARCHIVE_PROPOSED, CITATION_MISSING). CHANGED with no judgment either
    way (UNCLEAR, as without an LLM) gives a proposal with
    CITATION_UNJUDGED: the no-LLM escalation. Contradicted beats missing
    beats unjudged, one row per entry per change. A PROPOSED entry is only
    checked: triage reads the fresh results.
  - **When it asks instead of acting.** A verified entry, one on a LOCKED
    page, or one a person put back after a dispute in the last 90 days
    (`STANDING_ENTRY_DECAY_DAYS`) gets an archive proposal with
    CITATION_CONTRADICTED and the same issue, not a dispute: a person has
    read the claim or the code, and the judge is a model. A proposal is not
    made while one is open for the entry, nor for 90 days after a person
    declined one for the same reason, so the queue does not ask again on
    every change to the file.
  - **The correction issue (`upkeep/knowledge-issues.ts`).** Opened through
    `IssuesService.createIssueAPI` (numbering, history, notifications and
    the team's triage suggestions all apply) by a System bot member
    (`ensureIntegrationBot`, slug `vantik-knowledge`), with no assignee: a
    person or the team's own automation decides. The team: the module's
    owning team; a module a product owns has none and a product has no
    default team, so the first live team it links stands in, then the team
    with the most issues in the modules, then the workspace's oldest team.
    The modules: the cited file's module and the entry's modules. The state:
    the team's TRIAGE state, else BACKLOG, else UNSTARTED, else its first.
    The label `knowledge`, made on first use (revived if deleted). The
    title quotes the entry; the body cites the entry id and page, the
    change's sha and repository, each citation's lines as cited and the
    judge's reason, all through `redactSecrets`, since cited code can hold a
    credential the entry never could. The issue is opened after the dispute
    commits; one a run failed to open is opened by the next run in the
    workspace once the row is ten minutes old, claimed by a compare-and-set
    on `updatedAt` so two runs never open two.
  - **Proposals in the review queue.** `GET /api/v1/knowledge/review` lists
    open proposals whose entry is still STANDING, with or without triage,
    with the reason (`CITATION_MISSING`, `CITATION_UNJUDGED`,
    `CITATION_CONTRADICTED`, and later `UNUSED`) and a summary built from
    the evidence. `POST /api/v1/knowledge/review/proposals/:id {accept}`:
    accepting archives the entry through `updateEntry`, with the proposal
    resolved (`update` where OPEN) in the same transaction, so of two
    answers the second fails with its change (409); declining marks it
    DECLINED with a conditional update. People only. The webapp shows each
    as a question with "Archive it" and "Keep it", never in bulk.
  - **Undo.** A person setting STANDING on a DISPUTED or ARCHIVED entry
    (`updateEntry` or bulk) marks the gardener's unreversed DISPUTED or
    ARCHIVED rows for it reversed, in the same transaction. Archiving a
    disputed entry is agreeing with it, not an undo.
  - **Tests.** The fakes of two existing suites gained a
    `pageEntryMaintenance` table (the undo write goes through it); no
    assertion changed.
- **Decay (KG-6.5).** Both passes keep an entry any of whose citations a
  check found to hold within the pass's window (`checkedAt` in the window,
  and HOLDS, MOVED, or CHANGED with a HOLDS judgment: MOVED is the same code
  on other lines). The standing pass's rule is `unusedSince(cutoff)` in
  `upkeep/maintenance.ts`: older than the window, not served within it, and
  no citation held within it. The inbox pass, which has no serving to go
  by, uses the check alone. Contradicted, unjudged, missing or unread
  results keep nothing. A verified entry is never archived: the standing
  pass kept `verifiedAt: null`, the inbox pass now has it too (a verified
  entry still waiting is already in front of a person), and after each pass
  `KnowledgeUpkeepService.proposeUnused` gives each verified entry the
  standing rule would take an archive proposal with reason UNUSED and the
  window as evidence, not repeated while open or for 90 days after a
  decline. Outcomes archive nothing: the passes read no signal counts, and
  a harmful signal still queues a re-check of the entry (KG-3.4), whose
  result is what decay reads. The one place outcomes take an entry out of
  use is KG-6.3's disabling of a candidate convention, which the plan asks
  for and a person can reverse. The existing decay tests' matcher was
  taught `none`, `in` and `gte`, and rows got an empty citation list; their
  assertions are unchanged (and now also require the row's status to match
  the pass's).
- **Migration** `20260927060000_knowledge_upkeep`: `prisma migrate diff`'s
  output for all of phase 6 (three enums, `PageEntryMaintenance`,
  `KnowledgeFinding`, and four nullable columns on `PageKnowledgeGap`).
  Replayed on postgres 16 over the earlier migrations; the diff against
  the schema is then empty. The new tables are not replicated.

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

### Phase 2, round 3 (same reviewer, on the round 2 fixes)

`VERDICT: NO UNRESOLVED FINDINGS`. All three round 2 fixes confirmed by
mutation, including the workspace filter on the moved-repository fallback
and the retry still counting skipped citations as unread. One non-blocking
test gap, fixed: the local reader's "too large" answer carried
`thisFileOnly` untested; a test now answers git's maxBuffer error and
asserts the flag, and fails with it removed. The reviewer also noted, as
intended, that a 404 on a very slow GitHub can come back UNKNOWN within the
15-second bound instead of refusing the write: it errs toward unread.

Phase 2 review: PASS - three rounds by one fresh reviewer subagent over the
phase diff against PLAN.md and the KG-2 criteria: the citation model and
hand-written migrations matched against `prisma migrate diff`; checks at
write refusing with the citation named and writing nothing; one file
source for GitHub and local git with workspace isolation, no path or
argument injection, folders refused, bounded reads, and unreachable sources
unread (never failed) and retried; text-only relocation; a judge on another
role, stored, UNCLEAR with no model; non-code existence checks scoped to the
workspace; trust tiers and Typesense ranking; proof from postgres on every
served path, a written entry included; mutation checks on each; no skipped
or loosened tests, checklist and verifier untouched by the session (KG-2.1's
path was later moved at the maintainer's request).

### Phase 3, round 1 (fresh reviewer subagent)

The reviewer read the phase diff (60f5db7..3b0ceac) against PLAN.md and the
KG-3 criteria, ran the phase's suites, replayed `prisma migrate diff` against
the hand-written migration (it matches), and mutated the signals service.
What held: uses written in the serve's transaction on all three paths, the
pack's order and budget, the arm stable across retries with nothing served
to the holdout, counts that only move with their signal row, re-checks on
the `pages` queue with nothing archived, workspace scoping of the plugin
capability, and agent tokens refused by the comparison. One blocking
finding and six non-blocking, all fixed:

1. **Blocking: the per-workspace override could not be saved.**
   `UpdateWorkspacePreferencesDto` declared only `agentRuns`, and the global
   pipe's `whitelist` dropped `knowledge`, so `knowledge-settings.ts` read a
   key nothing could write. The DTO now declares `knowledge` as an optional
   object (`update-workspace-preferences.dto.ts:28`); `knowledgeSettings`
   still reads it value by value. Test: `validation.spec.ts` "[KG-3.3] keeps
   a workspace's knowledge settings", through the real pipe; it keeps the
   object and refuses a string.
2. **No test pinned the "checks passed" half of HELPFUL.** Dropping the
   verification check survived. New test "[KG-3.4] is helpful only when the
   checks passed and the reviewer accepted, both": accepted with a failing
   check elsewhere, and checks passing with the reviewer not accepting, each
   give nothing.
3. **"Reads the last pass" did not test which pass.** The double ignored
   `orderBy` and `take`; it now honours both, so reading the first pass fails
   the test.
4. **Mean cost left out failed runs' spend.** `HostedExecutor.fail` wrote
   only `egressDenied`. It now writes `costUsd` when the run spent anything:
   a pass-1 crash reports the attempt's spend, and every failure after a
   cycle (no diff, push rejected, a crash later) reports the cycle's. Test:
   "[KG-3.6] says what a failed run spent" in `hosted-cycle.spec.ts`.
5. **A pull request a person opened from the run's branch credited
   nothing.** Now matched by head branch and repository as described under
   Decisions (`knowledge-signals.service.ts:244`, at most 20 runs read per
   branch). `pr-sync.ts` and the plugin context pass the branch, repository
   and opening time. Tests: "[KG-3.5] credits the run whose branch a person
   opened the pull request from" (an older run on the same reused branch and
   a later one are passed over) and "does not credit a branch of the same
   name in another repository, or a run with its own pull request"; the
   plugin and pr-sync specs check the new fields.
6. **Uses from MCP had no session.** The header was undocumented and no
   documented client sends it. `recall_knowledge` and `load_context` now
   take a `session` argument (`mcp.tools.ts:774`), agent-core sends a
   per-call session as that call's header (`client.ts:88`), and
   `connect-mcp.mdx` documents both. Tests in `mcp.tools.spec.ts` and
   `agent.spec.ts`.
7. **A doc comment on the wrong model.** `PageKnowledgeGap`'s comment sat
   above `PageEntryUse`; moved back. Comments only, so no migration change.

Every new test fails with its fix reverted (14 mutations, all caught).

### Phase 3, round 2 (same reviewer, on the round 1 fixes)

All seven fixes confirmed, including three mutations of the branch matching
(the opening-time bound, the repository check, a run's own pull request),
all caught. One new non-blocking finding in fix 6, fixed: a `session`
argument with a newline or a character past Latin-1 went out unchanged as a
header, `fetch` refused it, and the agent was served nothing and told Vantik
could not be reached. The server drops a session it cannot use rather than
failing the read; agent-core now does the same (`headerSession` in
`client.ts`), for a client's session and a call's, to the server's rule
(printable ASCII with no spaces, at most 200). Test: `agent.spec.ts`
"[KG-3.1] drops a session it cannot send, rather than failing the read",
whose fetch double checks headers as real fetch does; four mutations (each
call site, the length, the character rule), all caught. `connect-mcp.mdx`
states the rule for both routes.

### Phase 3, round 3 (same reviewer, on the round 2 fix, and a final pass)

`VERDICT: NO UNRESOLVED FINDINGS`. The reviewer re-ran its round 2
reproduction against the rebuilt agent-core with real `fetch` and a local
server: a session with a newline, or one in Chinese, now reads the
knowledge and sends no header. Final pass over the phase: KG-3.1 to KG-3.6
pass in the verifier with every suite green, and nothing it verified in
rounds 1 and 2 moved.

Phase 3 review: PASS - three rounds by one fresh reviewer subagent over the
phase diff against PLAN.md and the KG-3 criteria: uses recorded in the
serve's transaction on every path, with the session from a header or the
tool argument and an unusable one dropped; run knowledge packed as
conventions then top K grounded entries within one budget; a deterministic,
retry-stable holdout that is served nothing, clean because the hosted guest
cannot reach Vantik; signals from runs and pull requests (a person's pull
request from the run's branch included) that count once per entry, run and
source, re-check on the `pages` queue and archive nothing; an arm comparison
that counts failed runs' cost, members only; settings with an env default
and a per-workspace override that can be saved, read through one function;
a hand-written migration matching `prisma migrate diff`; mutation checks on
each fix; no skipped or loosened tests, checklist and verifier untouched.

### Phase 4, round 1 (fresh reviewer subagent)

The reviewer read the phase diff (3daa793..87579fb) against PLAN.md and the
KG-4 criteria, ran the seven affected suites (194 tests), replayed
`prisma migrate diff` against the migration (it matches), and tested one
SQL expression on the container's postgres. Three blocking findings and
five non-blocking, all fixed:

1. **Blocking: EXTERNAL_INPUT rested on the session the writer names.** The
   run was found only by `sourceSession`, which any MCP, CLI or REST client
   sets or leaves out, so an agent on a GitHub-synced issue could write
   without a session and be accepted. Now established by the server
   (`writerOf`, `knowledge-triage.service.ts:642`): the writer's own runs
   open when the entry was written, as under Decisions; an agent's entry in
   no run escalates with the new UNKNOWN_SOURCE; comments mirrored from
   outside count, including after their link is gone (`triage-policy.ts`,
   `commentSourceOf`). SKILL.md's wording now says what the check does.
   Tests: "[KG-4.8] finds the runs the writer was in from its own record,
   never from the session it names" (a session naming another agent's
   internal run, a harness id, none), "counts the runs of the writer that
   were open when the entry was written, and no others" (finished before,
   started after, another agent, deleted, another workspace; the two edges
   count), "escalates an agent's entry written outside any run the server
   knows of" (its repeat too, and a writer with no user record), "holds a
   person to what they wrote, not to a run", "reads a comment mirrored from
   outside as outside input, after its link is gone too".
2. **Blocking: applying acted on neighbours as read before the model
   calls.** A neighbour verified, reworded or locked while the judges
   answered was still disputed, and a repeat was archived against a target
   deleted or archived meanwhile. Each update is now conditional as under
   Decisions, and any miss rolls the whole application back and records the
   decision as not applied (`apply` and `record`). The spec's store now rolls
   back a transaction that throws, as postgres does. Tests: "[KG-4.6]
   disputes nothing, and accepts nothing, when what it contradicts was
   verified by a person / reworded / on a page that was locked / archived
   while it decided", "undoes every change it made when one entry it
   contradicts changed", "[KG-4.1] leaves the repeat in the inbox when what
   it repeats was archived / deleted / reworded after it was found",
   "[KG-4.2] folds in nothing when the near duplicate was reworded while
   the judges answered"; the KG-4.3 stale-entry test now checks the recorded
   reason.
3. **Blocking: the backfill hashed differently from `contentHashOf` for
   text starting or ending in v.** Fixed as under Decisions (migration).
   Checking the fix on non-ASCII samples found a second difference, the
   no-break space, which postgres's `\s` leaves out; the backfill now spells
   out JavaScript's whitespace, and all 20 samples agree. All migrations
   replayed on postgres 16, with `migrate diff` against the schema empty.
4. **Credentials could reach the models** through a citation's snippet or
   an older neighbour's content. Both, and cited issue and comment text, are
   now redacted (`redactSecrets`). Tests: "[KG-4.8] withholds a credential
   in anything it shows a model" (each route, both prompts) and "withholds
   every credential in text it shows a model, and leaves the rest as
   written". Writing that test found that markdown escaping hid a token from
   the patterns, hence plain text for cited issues and comments.
5. **Unscoped entries were never BROAD_SCOPE**, though served everywhere
   and compared with one page. Now BROAD_SCOPE, and the constant's comment
   says "more than three". Tests: a KG-4.4 case for no scope, and "[KG-4.4]
   reads a scope over three modules as broad, and three as not".
6. **A non-code citation that held only said its target existed**, and the
   judges saw just its label. The judges now see a cited issue's and a
   comment's text, and one from outside escalates with EXTERNAL_INPUT.
   Tests: "[KG-4.4] the text of a cited issue or comment, not only that it
   exists" (another workspace's issue and a pull request are not shown),
   "no more of a cited issue than one screen of it", and "[KG-4.8] never
   accepts an entry that rests on an issue or comment from outside".
7. **The production wiring of "is a model configured" was untested.** New
   test "[KG-4.7] read the deployment: no model until all four settings are
   there", on `new TriageJudges()` with the `LLM_*` variables cleared and
   restored.
8. **Any member or write-scoped agent token could overwrite workspace
   preferences** through `POST /workspaces`, which passed its body to
   Prisma; with triage settings there, that could switch triage on and set a
   threshold at which nothing is compared. Fixed here rather than split off,
   because this phase is what made it matter: `updateWorkspace` now writes
   only `name` and `icon`. Test: `update-workspace.spec.ts` "[KG-4.5]
   changes its name and icon, and never its preferences".

35 mutations over the fixes, each a change that compiles, all caught.

### Phase 4, round 2 (same reviewer, on the round 1 fixes)

Seven of the eight round 1 findings confirmed fixed (B2, B3, N1 to N5), the
backfill re-checked on postgres. One blocking finding left, and one new
non-blocking one, both fixed:

1. **Blocking: a run that happened to be open cleared an agent's entry (B1,
   narrower).** Round 1 took the writer's open runs as the context the entry
   was written in, and cleared UNKNOWN_SOURCE when there was one. But runs
   do not write (ENG-84), so a match is always a coincidence: an agent that
   picks up an internal issue for itself starts a hosted run as itself, and
   can then write from a GitHub-synced issue it only read, citing code, and
   be accepted. Now every entry not written by a person gets UNKNOWN_SOURCE
   when it would be accepted (`writerOf` returns `unknownSource: !person`),
   as described under Decisions; open runs are still read, and can only add
   EXTERNAL_INPUT. UNKNOWN_SOURCE is added in the acceptance stage, so an
   agent's repeat is still folded in (a positively outside one is not).
   The pipeline's tests now write as a person by default (`fresh()`), and
   the agent's cases say so (`agentEntry()`). SKILL.md and the
   always-in-context summary now say that nothing an agent writes is
   accepted without a person. Tests: "[KG-4.8] never accepts an agent's
   entry, whatever run it had open, since what it read cannot be told" (an
   internal run, a handback run, none; no user record, an unknown user, a
   System account), "[KG-4.1] still folds an agent's repeat into the entry
   it repeats" (exact and near), and the run-reading tests now expect
   UNKNOWN_SOURCE beside any EXTERNAL_INPUT they find.
2. **A cited issue was not read for mirrored comments,** though these notes
   said it was. The cited-issue query now reads its comments written before
   the entry, as the run's does. Tests: a case in "[KG-4.8] never accepts an
   entry that rests on an issue or comment from outside", and a comment
   mirrored after the entry that does not count.

39 mutations over rounds 1 and 2, all caught, among them clearing
UNKNOWN_SOURCE for an agent with an open run (the finding itself) and
adding it before the repeat stage.

### Phase 4, round 3 (same reviewer, on the round 2 fixes, and a final pass)

No unresolved findings. The reviewer re-ran its round 2 scenario (a
self-assigned internal issue's hosted run, then an entry drawn from a
GitHub-synced issue the agent only read) and the shared-account and
`delegate_task` variants: each now escalates with UNKNOWN_SOURCE. N6
confirmed, with the date filter exercised. It agreed with folding an
agent's repeat in despite UNKNOWN_SOURCE, finding no failure scenario:
folding only archives the new row and counts it on a target that is still
live and unchanged; nothing outside triage reads `corroborationCount` or
`PageEntryRelation`; displacement needs AUTO_ACCEPT, which an agent's entry
cannot reach; and stopping it would leave KG-4.1 unmet for the writer of
nearly every proposed entry. A caution it raised, recorded under Observed:
a later phase that reads `corroborationCount` as a signal must tell
unknown-source increments apart. Final pass: KG-4.1 to KG-4.8 met as
written, UNKNOWN_SOURCE recorded under Decisions as an addition, and every
round 1 fix still in place.

Phase 4 review: PASS - three rounds by one fresh reviewer subagent over the
phase diff against PLAN.md and the KG-4 criteria: a triage job per new entry
on the `pages` queue, once per entry, recording every decision with its
inputs, digest, models and raw answers; exact repeats found by a hash the
migration backfills exactly as the server computes it, and near neighbours
related by rule first and by two agreeing judgments otherwise, as links;
auto-acceptance only when every condition holds, with an agent's entry
never accepted without a person while runs have no credential of their own,
and outside input (a run's issue, its mirrored comments, a cited issue or
comment) escalating even a repeat; precedence decided in code; acting only
in `on` mode, only on what was compared, rolled back and recorded as not
applied when anything changed; credentials refused at write and withheld
from every model; shadow by default with a per-workspace override only an
admin can change; a hand-written migration matching `prisma migrate diff`;
mutation checks on every fix; no skipped or loosened tests, checklist and
verifier untouched.

### Phase 5, round 1 (fresh reviewer subagent)

The reviewer read the phase diff (52eef46..HEAD) against PLAN.md and the
KG-5 criteria, ran the affected server suites (238 tests) and the two webapp
specs, ran `pnpm typecheck`, replayed `prisma migrate diff` against the
migration (it matches) and ran the advisory lock on postgres in a
rolled-back transaction. One blocking finding and five non-blocking, all
fixed or answered:

1. **Blocking: a backed-off type resumed on no evidence about itself.**
   Each type's `samples` was every rated verdict in the window, and for
   CORROBORATE and REJECT a window with none about them is all "neither",
   whose kappa is null and read as agreement: REJECT backed off 31 days ago
   resumed on the twentieth AUTO_ACCEPT verdict. Now a type's samples are
   the verdicts about it (`agreement.ts`, `agreementByType`), and no
   verdicts about a type changes nothing whatever the minimum
   (`shouldBackOff`). Tests: "[KG-5.4] resumes or backs off a type only on
   verdicts about that type" (the reviewer's case end to end, and the next
   finding's), "[KG-5.4] counts as evidence about a type only the verdicts
   where it was said", "[KG-5.4] changes nothing on no verdicts about the
   type, whatever the minimum". The settings panel counts the same way.
2. **The minimum was not per type,** so one audited repeat answered "not a
   repeat" among nineteen other verdicts backed CORROBORATE off. Fixed by
   the same change; covered by the first test above.
3. **ESCALATE was not measured.** Now reported beside the acting types, in
   the endpoint and on Settings, and never backed off (`MEASURED_DECISIONS`;
   `reevaluate` skips it). Tests: "[KG-5.3] measures each type against the
   rest, with the counts" (ESCALATE at 5/9 by hand), the endpoint test, and
   "[KG-5.3] reports sending to a person beside the rest, never as held
   back" in the webapp.
4. **Disagreeing with an audit only partly undid it,** though the button's
   hint said "Undoes what it did". A folded repeat's corroboration is now
   taken back ("[KG-5.2] disagreeing with a folded repeat takes back the
   corroboration it counted"), and the hint says what it does: "Reverses
   what it did to this fact". What an audited acceptance displaced stays
   DISPUTED: setting the acceptance aside does not say the neighbour was
   right (it may have been set aside as not worth serving, not as false),
   so restoring it would be a second decision nobody made. Recorded under
   Observed.
5. **Two people answering one audit at once** left the verdict as the first
   gave it and the entry as the second left it. The answer's verdict write
   is now strict and rolls the answer back when another landed first, and
   an answer that finds the audit already answered changes nothing (409).
   Test: "[KG-5.2] of two answers at once, keeps the first and refuses the
   second with its change" (a verdict landing before the change commits,
   and before the verdict is read).
6. **Folding an audited entry into its page dropped the audit.**
   `PagesService.consolidate` now records ACCEPTED on audited entries when
   a person consolidates, in its transaction, and re-evaluates. Test:
   "[KG-5.5] a person folding an audited entry into its page keeps it; an
   agent decides nothing".

Mutation-checked: 16 mutants over the fixes, all killed (two reworded to
compile; one survived at first because a test's two scenarios shared
fixture rows, now separate).

### Phase 5, round 2 (same reviewer, on the round 1 fixes, and a final pass)

The reviewer checked the three fix commits and made a final pass over the
phase: the pages suites (376 tests) and the webapp specs, `pnpm typecheck
--force`, and the strict audit write against Prisma 6 and postgres (the
non-unique filter is accepted and throws P2025, rolling back the batch).
All six round 1 findings resolved, including the answer on displaced
neighbours. No blocking findings; three non-blocking, now fixed or
answered:

- **A. Weighting audits backed acceptance off at 95% agreement.** Twenty
  audited acceptances, one set aside, beside two escalations set aside,
  came to kappa 0.27 weighted (0.78 unweighted), and a type would stop and
  resume as audits came and went. Kappa is now over the verdicts as given,
  as KG-5.3 reads; the weighted cells stay in the report for reading.
  Tests: "[KG-5.4] keeps acceptance acting at nineteen agreements in twenty
  audits" (76/98 by hand), "[KG-5.3] counts each verdict once, and shows
  what the audits stand for".
- **B. The corroboration decrement is not tied to the verdict landing,** so
  two people un-folding one audited repeat at once from the rail or in bulk
  take two off its count. Answered under Observed: the queue's own answer
  is strict, the count cannot go negative and is unread, and making every
  un-fold strict would make the race an error for the second person.
- **C. An audit the queue had stopped listing could still be answered.**
  `resolveAudit` now refuses (409) once the entry is no longer in the
  status the decision left it, as the queue does. Test: "[KG-5.2] closes an
  audit whose entry has moved on since".

### Phase 5, round 3 (same reviewer, on the round 2 fixes)

The reviewer checked d1688df and 500a859: the pages suites (377 tests), the
webapp specs, `pnpm typecheck --force`, and 76/98 by hand. A and C fixed, B's
answer accepted, every earlier finding still resolved, no blocking findings.
Verdict PASS, with two new non-blocking points, both now fixed:

- **1. PROGRESS still listed the weighted 0.625 test** removed in d1688df.
  The Kappa bullet no longer lists it.
- **2. Acting on an audited entry by hand still gave a verdict once the
  audit was closed** (decay archives an audited acceptance, and a person
  bringing it back was counted against AUTO_ACCEPT). `verdictsFor` now
  takes a verdict on an audit only while the entry is in the status the
  decision left it, the rule the queue and `resolveAudit` use
  (`statusLeftBy` moved to `triage/agreement.ts` so all three share it).
  Test: "[KG-5.5] acting by hand on an audited entry that has moved on
  gives no verdict", which fails against the old condition.

### Phase 5, round 4 (same reviewer, on the round 3 fixes)

No unresolved findings, blocking or not, from any round. The reviewer read
05e696a, ran the pages suites (378 tests), `pnpm typecheck --force` and
eslint on the changed files. Both round 3 points resolved: the Kappa bullet
lists only the tests that exist, and `verdictsFor` takes a verdict on an
audit only while its entry is where the decision left it, the rule the
queue and `resolveAudit` share through `statusLeftBy`. It checked the other
callers still meet it (bulk triage on an audited repeat or refusal sees
ARCHIVED; consolidation passes STANDING) and that the earlier by-hand and
consolidation tests still pass.

Phase 5 review: PASS - four rounds by one fresh reviewer subagent over the
phase diff against PLAN.md and the KG-5 criteria: a review queue that is the
inbox with each escalation's reasons, plus open audits, and exactly the
inbox with triage off; audits drawn by a hash of the decision id over every
applied acting decision but a SECRET refusal, answered strictly (the second
answer, and an answer on an entry that moved on, get 409) and undone
through the ordinary entry update, a folded repeat's corroboration taken
back; Cohen's kappa per decision type, one type against the rest, each
verdict counted once, ESCALATE reported but never backing off, the weighted
cells for reading only; back-off and resumption only on enough verdicts
about the type, as append-only rows under a per-workspace advisory lock;
verdicts recorded in the change's own transaction, the first of two people
kept, never from an agent, on audits only while their entry is where triage
left it; a hand-written migration matching `prisma migrate diff`; mutation
checks on every fix; no skipped or loosened tests, checklist and verifier
untouched.

## Needs a decision

Anything that blocks the plan: a criterion that is wrong or cannot be met, or
an environment problem such as Prisma being unable to download its engines.
Give the evidence, and stop until the maintainer answers.

(Nothing blocking the work.)

- **The goal's spec hash.** The goal set for phases 4-7 asks for a verify
  line containing `spec-hash 069a84bf6612`, the hash of the original
  `checklist.json` and `verify.mjs` (885adff). They now hash to
  `8409159da053`, because KG-2.1's file check was moved to `skills/` at the
  maintainer's request (60f5db7; GOAL.md carries the new hash). Going back
  would mean editing `checklist.json`, which the plan forbids, and would
  fail KG-2.1 against `main`. So the verify line will read
  `8409159da053`; the maintainer should confirm that hash as the goal's.

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
  write). Since phase 4, triage orders them by time and id, so exactly one
  corroborates the other; the write itself still admits both.
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
  correction cannot see what it retires. Predates phase 0. Phase 5's queue
  shows why an entry waits (SUPERSEDE_REQUEST among the reasons) but still
  not what it would retire.

- **`PageEntryUse` grows one row per entry per serve** and nothing prunes
  it. It is indexed for the reads phase 3 makes (by run, by entry and time,
  by workspace and time). Worth a retention pass, perhaps beside decay.
- **Pull request outcomes come only from GitHub.** Another source that opens
  pull requests would call the same `agentRuns.pullRequestChanged`
  capability.
- **`corroborationCount` counts repeats from unknown sources too.** An
  agent's repeat is folded in although what it read is unknown (phase 4,
  round 3). Nothing reads the count yet; a phase that starts using it as a
  signal should tell those increments apart, from the decision rows (writer
  and `corroboratedEntryId`).
- **Undoing a folded repeat that was not audited leaves the count.** A
  verdict on an audited repeat that puts it back into use takes the
  corroboration back; a repeat that was not audited, put back into use by
  hand, gives no verdict (it is not a sample) and nothing takes its
  corroboration back. Nothing reads the count yet.
- **Kappa's prevalence paradox.** In a window where people agreed with
  every verdict about a type but one, and never said anything else, kappa
  is 0 (one rater used one class throughout) and the type backs off once
  it has the minimum. Escalations people set aside and shadow decisions
  usually give it both classes (nineteen of twenty audits kept, beside two
  escalations set aside, is 0.78); where they do not, it fails safe,
  towards a person deciding. Worth watching in the first weeks of `on`.
- **Un-folding one audited repeat twice at once takes two off its count.**
  Two people putting the same audited repeat back into use at the same
  moment from the rail or in bulk (not from the queue, whose answer is
  strict) each commit the decrement, while only one verdict lands. The
  count cannot go below zero and nothing reads it yet. Making every
  un-fold strict would turn that harmless race into an error for the
  second person, so it is left.
- **An audited acceptance that is undone leaves what it displaced
  DISPUTED.** When an accepted entry won against a STANDING neighbour,
  that neighbour was disputed in the same transaction; a person setting
  the accepted entry aside afterwards does not restore it. DISPUTED is
  reversible and withheld until a person looks, so nothing wrong is
  served, but the neighbour waits on someone finding it.
- **Runs write with no credential of their own (ENG-84).** Until they do,
  triage cannot vouch for what an agent read, so no agent's entry is
  auto-accepted. A run-bound credential stamped by the server would let a
  run vouch for what it wrote.

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
- 2026-09-27: Review round 3: no unresolved findings; the one test gap
  fixed. Phase 2 review: PASS. Stopped for the maintainer's answer on
  KG-2.1's checklist path before phase 3.
- 2026-09-27: The maintainer asked for KG-2.1's checklist path to be moved to
  `skills/`; done, with GOAL.md's hash updated to `8409159da053`. Verify
  through phase 2: PASS, 23/23. Phase 2 done; starting phase 3.
- 2026-09-27: Phase 3 implemented (KG-3.1 to KG-3.6) with tagged tests; the
  knowledge settings reader added for the plan's per-workspace override. 29
  mutations over the new code, all caught. Verify: phases 0-2 PASS, phase 3
  6/7 (review pending); all suites and typecheck green.
- 2026-09-27: Phase 3 pushed to PR #44 (3b0ceac); CI green, including the
  migration replay. Review round 1: one blocking finding (the workspace
  override could not be saved) and six non-blocking; all fixed with tagged,
  mutation-checked tests.
- 2026-09-27: Review round 2 (6a0ed75): all round 1 fixes confirmed; one new
  non-blocking finding (a session `fetch` cannot send failed the read) fixed.
- 2026-09-27: Review round 3 (cc25aa1): no unresolved findings. Phase 3
  review: PASS. Verify through phase 3: PASS. Phase 3 done; PR #44 ready for
  review.
- 2026-09-27: Phase 4 implemented (KG-4.1 to KG-4.8) with tagged tests
  against an in-memory store; 27 mutations over the new code, all caught.
  The goal's spec hash differs from the checklist's current one; recorded
  under Needs a decision. Verify through phase 4: 38/39, only the review
  open; all suites and typecheck green.
- 2026-09-27: Phase 4 review round 1: three blocking findings (external
  input rested on the writer's session, applying acted on stale neighbours,
  the backfill trimmed the letter v) and five non-blocking; all fixed with
  tagged tests, 35 mutations caught. Server suite 1625 passed.
- 2026-09-27: Phase 4 review round 2: B1 still open in a narrower form (an
  open run of the same agent cleared its entry); every entry not written by
  a person now waits for one. N6 (a cited issue's comments) fixed. 39
  mutations caught.
- 2026-09-27: Phase 4 review round 3: no unresolved findings. Phase 4
  review: PASS. Verify through phase 4: PASS, 39/39. Phase 4 done; starting
  phase 5.
- 2026-09-27: Phase 5 implemented (KG-5.1 to KG-5.5) with tagged tests:
  verdicts recorded with the change, weighted kappa per acting type, audits
  drawn by decision id, back-off with hysteresis under an advisory lock, the
  review and agreement endpoints, the queue's reasons and audits, and the
  Settings panel. Mutation-checked: of 55 server mutants, 46 were killed at
  once; four survivors were killed by new tests (the verdict race, a verdict
  already given, audit weights in the report, the latest decision in the
  queue); four that did not compile or whose pattern missed were reworded
  and killed; one was equivalent (only an escalation carries reasons) and
  was removed by simplifying the code. 13 webapp mutants, all killed after
  two tests were tightened. Verify through phase 5: 44/45, only
  KG-5.R left. Review round 1 started.
- 2026-09-27: Phase 5 review round 1: one blocking finding (a backed-off
  type resumed on verdicts about other types) and five non-blocking (the
  minimum not per type, ESCALATE not measured, an audit only partly undone,
  two answers to one audit at once, consolidation dropping an audit). All
  fixed or answered, with tagged tests; round 2 started.
- 2026-09-27: Phase 5 review round 2: all round 1 findings resolved, no
  blocking findings, three non-blocking (audit weights backing acceptance
  off at 95% agreement, a decrement race, stale audits answerable): two
  fixed with tagged tests, one answered. Round 3 started.
- 2026-09-27: Phase 5 review round 3: verdict PASS, round 2's points
  resolved, two new non-blocking points (a stale line in PROGRESS, a
  verdict on a closed audit through a by-hand action), both fixed, the
  second with a tagged test that the old condition fails. Round 4 started
  to confirm them.

- 2026-09-27: Phase 5 review round 4: both round 3 points resolved, no
  unresolved findings from any round. Phase 5 review: PASS. Verify through
  phase 5: PASS, 45/45. Phase 5 done; starting phase 6.
- 2026-09-27: KG-6.1 (merged pull requests and default-branch pushes carry
  the commit they landed as; one re-check job per commit) and KG-6.2
  (landed changes re-check the citations they touch; disputes with a
  correction issue labelled knowledge; archive proposals in the review
  queue; undo recorded) implemented with tagged tests. Mutation-checked:
  19 server mutants for KG-6.2, 15 killed at once, three survivors and one
  that did not compile killed by new tests or a compiling rewording.
- 2026-09-27: KG-6.5 (decay keeps what a check found to hold; verified
  entries are proposed, never archived; outcomes archive nothing)
  implemented with tagged tests. Mutation-checked: nine mutants, eight
  killed at once, one that did not compile reworded and killed.
