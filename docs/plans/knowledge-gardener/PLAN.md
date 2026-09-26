# Knowledge gardener

Vantik's knowledge bank already stores atomic, scoped facts (`PageEntry`) with
provenance, supersession, usage-based decay and a record of unanswered
questions. This plan makes it tend itself. Facts get grounded in code, agent
runs teach it which facts help, an LLM triages first, and people handle
escalations plus a random audit. It also connects the bank to the product
graph (Product → Module → Capability) and to hosted agent runs, which today
receive no knowledge at all.

Read this whole file before writing code. The acceptance criteria are in
[`checklist.json`](./checklist.json), and [`verify.mjs`](./verify.mjs) is
the only judge of whether they pass.

---

## 1. How to work

### Setup

```bash
pnpm install
node docs/plans/knowledge-gardener/verify.mjs --list --phase 0   # read the criteria
node docs/plans/knowledge-gardener/verify.mjs --through 0        # full check
```

- **Prisma must be able to download its engines** from `binaries.prisma.sh`.
  If `prisma generate` fails with a 403, the environment's network policy
  blocks that host. Stop and report it: every server test and the typecheck
  depend on it, and no code change can fix it.
- **The unit tests need no services.** Do not start docker for this plan.
  End-to-end tests (`pnpm e2e`) are welcome but not required.

### Order and scope

- **Work phase by phase, in order (0 → 7).** Each phase depends on the
  earlier ones. Do not start a phase while an earlier one fails
  `verify.mjs --through <that phase>`.
- **Implement what the criteria and this plan describe, and no more.** Where
  the plan leaves a choice open, choose what fits the surrounding code, and
  record the choice in `PROGRESS.md`.
- **Phase 0 overlaps two open tasks** (agents promoting their own entries,
  and the undebounced search). If `main` already contains a fix, do not redo
  it. Add the tagged tests that prove it, and move on.

### Tests are the evidence

- **Tag every test that proves a criterion** with its ID in the test name:
  `it('[KG-2.4] marks a citation MOVED when the snippet shifts lines', …)`.
  `verify.mjs` matches on the tag and passes a criterion only when a tagged
  test passes and none fails.
- **A tagged test must exercise the behaviour the criterion names.** Build
  the real service or controller with fakes for Prisma, Typesense, the LLM
  and the file source, following the existing `*.spec.ts` files next to the
  code you change. A test that asserts nothing about the behaviour is a
  failed review, not a pass.
- **Never call a real LLM, GitHub or network endpoint from a test.**
- **Every test in every suite must pass,** not only the tagged ones.
  `verify.mjs` runs the server, agent-core and cli Jest suites, the webapp
  Vitest suite, and `pnpm typecheck`.
- **Webapp criteria are tested through extracted logic** (hooks, utils,
  selectors) with Vitest, as the existing webapp specs do.

### Independent review, per phase

When `verify.mjs --through N` passes except for `KG-N.R`, get a review from a
reviewer that did not write the code:

- Spawn a fresh subagent (or run `/code-review`). Give it only this plan, the
  phase's criteria (`--list --phase N`) and the phase diff. Instruct it to find:
  - criteria that are not really met;
  - tagged tests that do not exercise their criterion;
  - regressions and security holes;
  - departures from the principles in §3.
- Every finding must cite a `file:line`.
- Fix each finding, or answer it in `PROGRESS.md`.
- Repeat until the reviewer has no unresolved findings, then write
  `Phase N review: PASS` in `PROGRESS.md` with a one-line summary of what it
  checked.

This mirrors Vantik's own review cycle for agent work
(`apps/server/src/modules/agent-runs/review-cycle.ts`). It also mirrors the
research: a separate judge catches what self-review misses.

### Rules that are never broken

- **Do not edit `checklist.json` or `verify.mjs`.** The goal checks their hash.
  If a criterion is wrong, contradicts the code, or cannot be met, stop and
  write it under **Needs a decision** in `PROGRESS.md` with the evidence.
  Do not weaken it.
- **Do not skip, disable or loosen an existing test** to get green.
- **Do not remove an existing safety check:** the LOCKED policy, the
  per-token budget, workspace isolation, `@RequiresScope`, or evidence
  filtering in review findings. The plan only adds checks.
- **Do not put secrets in knowledge, tests or logs.**

### Conventions in this repository

- **Comments explain *why*, in full sentences,** like the code around them.
  Read a neighbouring file before writing.
- **Migrations are hand-written SQL** in
  `apps/server/prisma/migrations/<UTC timestamp>_<name>/migration.sql`, with a
  comment explaining the change (see `20260925120000_remove_actions`).
  - Use `ALTER TYPE … ADD VALUE` for enum additions.
  - Validate with `pnpm --filter server exec prisma validate`.
  - To cross-check the SQL, run
    `prisma migrate diff --from-schema-datamodel <old schema> --to-schema-datamodel prisma/schema.prisma --script`.
    It needs no database.
- **Shared types go in `packages/types`.** Rebuild with turbo when the webapp
  or agent-core needs them; `verify.mjs` does this before running suites.
- **New tables are not replicated to the client** unless a screen needs them
  live. Follow the `ModuleRepo` pattern and read them with a plain request.
  `Page` and `PageEntry` are replicated
  (`apps/server/src/modules/replication/replication.interface.ts`).
- **Settings take their defaults from environment variables, with a
  per-workspace override** in `Workspace.preferences.knowledge`, read through
  one function the way `agent-runs/agent-run-settings.ts` reads
  `preferences.agentRuns`. Document each in `.env.example`.
- **Background work runs on the existing `pages` Bull queue**
  (`pages.processor.ts`). Scheduled jobs follow the `PAGE_DECAY_CRON` pattern:
  a fixed job id, old schedules cleared, `off` disables.
- **Every LLM call goes through `modules/ai-requests/llm-provider.ts`** by role
  (`fast`, `smart`), and every path that uses one has a working no-LLM
  fallback (`isLLMConfigured()`). With no LLM, deterministic stages still run,
  and decisions that needed the LLM escalate.

### Progress and commits

- **Keep `PROGRESS.md` current:** the phase in progress, decisions made,
  review results, anything blocked. It is the hand-off to the next session.
- **Commit in small, reviewable steps** with messages in the repository's
  style (imperative, explaining why). Push to the session's working branch.

---

## 2. What exists today

These are the file references a new session needs. Line numbers are
approximate.

| Area | Where | Notes |
|---|---|---|
| Models | `apps/server/prisma/schema.prisma` | `Page`, `PageEntry`, `PageKnowledgeGap`, `PageHistory`, `PageLink`, `PageLinkType` (TEAM, PROJECT, ISSUE, PAGE), `PageEntryStatus`, `Product`, `Module`, `ModuleRepo` (`pathPrefixes`), `Capability` (`moduleIds`), `AgentRun`, `AgentRunIteration` (`findings`, `verificationPassed`) |
| Entry writes and triage | `apps/server/src/modules/pages/page-entries.service.ts` | `createEntry` enforces LOCKED and budget and forces agent writes to PROPOSED. `updateEntry` (~148) and `bulkUpdate` (~196) never check `isAgent` (~409): the KG-0.1/0.2 hole. Decay ~268 ignores `lastServedAt`. |
| Routes | `pages/pages.controller.ts`, `pages/page-entries.controller.ts`, `pages/knowledge.controller.ts` | `POST /knowledge/context` lacks `@RequiresScope('read')`, so `modules/auth/agent-scope.ts` treats it as a write (KG-0.4). |
| Retrieval | `pages/knowledge.service.ts`, `modules/vector/vector.service.ts`, `vector.interface.ts` | One Typesense collection `pages`. Hybrid BM25 plus `ts/all-MiniLM-L12-v2` embeddings. Scope filter is exact (`scope:=`, ~867). Sort is text match, then `verified:2, scoped:1`, then `retrievalCount`. `recordDemand` writes counters and gaps. |
| Duplicate check | `packages/agent-core/src/agent.ts` ~1170 | Client-side only (`/knowledge/similar`, then needs-decision). Raw REST skips it (KG-0.3). |
| MCP tools | `apps/server/src/modules/mcp/mcp.tools.ts` ~700–970 | `load_context`, `recall_knowledge`, `list_pages`, `read_page`, `pages_for`, `link_page`, `remember`, `write_page`, `consolidate_knowledge`, `knowledge_gaps`, plus read-only product-axis tools. |
| CLI | `packages/cli/src/commands/knowledge.ts`, `knowledge-sync.ts` | `vantik kb …` |
| Links | `pages/page-links.service.ts` ~196–325 | Resolves only the four current kinds. |
| Module routing | `modules/modules/module-routing.ts` (`modulesForChangedPaths`), `module-routing.service.ts` | Person > deterministic > LLM suggestion. The LLM writes `IssueSuggestion`, never `Issue.moduleIds`. Reuse this authority order. |
| Code-change events | `integrations/github/pull-request.ts` (`parsePullRequestEvent`, `changedPathsOf`), `pr-sync.ts` (`merged_at`), `packages/types/src/common/integration.ts` (`CodeChangeEvent`) | Pull requests naming no issue key are dropped. The event carries no SHA (KG-6.1). |
| Agent runs | `agent-runs/context-pack.service.ts` (`knowledge: []` ~160), `agent-prompt.ts` (knowledge section ~108), `review-cycle.ts` (`ReviewFinding` with `evidence` as `file:line` or a failing command) | Runs hold no Vantik credential and cannot call MCP (ENG-84), so the context pack is how hosted runs get knowledge. |
| LLM | `modules/ai-requests/llm-provider.ts` | Roles `fast` and `smart`. Any OpenAI-compatible endpoint. Optional. |
| Issue origin | `Issue.sourceMetadata` | Set when an issue arrives through an integration (KG-4.8). |
| Webapp | `apps/webapp/src/modules/pages/*` (tree, `memory-rail.tsx`, `entry-row.tsx`, `review-queue.tsx`, `knowledge-gaps.tsx`), `modules/product-axis/*`, `modules/search/search-dialog.tsx`, `services/pages/index.ts` | The product-axis screens show no knowledge today. |
| Agent guide | `apps/docs/skills/working-vantik-knowledge/{SKILL.md,AGENTS.md}` | Served by `modules/agent-skill`. Keep it in step with every behaviour change. |

---

## 3. Principles (and the evidence behind them)

These decide the judgement calls the criteria leave open. When in doubt,
pick the option that keeps to them.

1. **Ground facts in something outside the model.**
   - A code claim is checked against the code at a SHA; a decision against
     the issue or PR where it was made.
   - Evidence: GitHub Copilot Memory stores citations and re-verifies them
     against the current branch before use; its A/B test moved the PR merge
     rate from 83% to 90%.
   - Only adding strictly verified experiences scored 38.5% against 13% for
     saving everything (Xiong et al., 2025).
   - Models checking their own work are unreliable (Huang et al.; Stechly et
     al.).
2. **Deterministic first, LLM only where needed.**
   - Hash before similarity, similarity before an LLM call. Tell "moved" from
     "changed" by content. Time and precedence logic live in code.
   - Evidence: Graphiti and Hindsight wrap every LLM decision this way.
     Contradiction handling is unsolved even for them: every system scored at
     most 7% on multi-hop conflict questions (MemoryAgentBench).
3. **Link, don't edit.**
   - Relations between entries (duplicate, refines, supersedes, contradicts)
     are rows. Existing text is not rewritten by an LLM.
   - When unsure, keep both: a different number, date, negation or condition
     means distinct.
   - Evidence: Mem0 v3 went add-only with links after its LLM update/delete
     step lost information.
4. **Raw evidence is never retired by a summary.**
   - Generated pages are derived from entries, cite them, and can be rebuilt.
     Refreshes are edits to sections, never whole rewrites, and a failed
     retrieval writes nothing.
   - Evidence: "Useful Memories Become Faulty" (2026) found repeated LLM
     consolidation eventually falls below no memory, while keeping raw
     episodes doubled accuracy.
   - ACE measured one rewrite collapsing an 18k-token memory to 122 tokens.
   - Hindsight added delta mode after a broken retriever overwrote a document.
5. **Learn from outcomes, in aggregate.**
   - Each run's result is a weak, noisy signal about the entries it was
     served. Counts accumulate, and a harmful signal triggers a re-check,
     never a delete.
   - Evidence: ACE's helpful/harmful counters. ReasoningBank learned from
     failures too, and a 70–90%-accurate judge still worked.
   - Outcome-based deletion plus selective addition gained about 10 points.
   - Cursor Bugbot promotes and retires learned rules from review signals.
6. **Humans review by exception, and the exception rate is measured.**
   - Escalate what the loop cannot settle, audit a random sample of what it
     did settle, and measure agreement with Cohen's kappa per decision type.
     Automation backs off on its own when agreement drops.
   - Evidence: Trust or Escalate (ICLR 2025). Percent agreement misleads
     (Judging the Judges). Judge reliability varies by task (Judge-Bench).
7. **The judge is not the writer.**
   - Use a different model role, or two judgments that must agree.
     Self-reported confidence is not a signal.
   - Evidence: self-preference bias; LLM overconfidence.
8. **Serve a few relevant items, with their proof and age.**
   - Evidence: ReasoningBank did better retrieving 1 memory than 4.
   - Chroma's context-rot study found every model degrades with length.
   - ETH Zurich's AGENTS.md study found always-loaded context files raised
     cost more than 20% without reliably helping.
   - Users of Claude Code and Codex complain about memories loaded with no
     age and ask for citations.
9. **Treat agent-written text as untrusted input.**
   - Memory poisoning succeeds at high rates (MINJA, AgentPoison), and an LLM
     trust-scorer accepted 54 of 82 poisoned entries.
   - Grounding, provenance, and never auto-accepting from runs that read
     external content are the defences.
10. **Use the graph Vantik already curates; do not extract one.**
    - Evidence: LLM extraction captures 48–66% of facts with about 30%
      duplicate nodes.
    - For single-fact lookup, reranked plain retrieval beat GraphRAG (60.9 vs
      49.3, GraphRAG-Bench).
    - Graphs built from a system of record work well (LinkedIn: +77.6% MRR).

---

## 4. Phases

Criteria text lives in `checklist.json`; the notes here are design guidance.

### Phase 0: Close the trust holes

Everything later trusts automated decisions, so the floor has to hold first.

- **KG-0.1/0.2:** Refuse agent-initiated triage in `updateEntry` and
  `bulkUpdate` (403 in the style of the LOCKED refusal). Thread the writer's
  identity into `bulkUpdate`.
  - An agent may still edit the content or scope of, or archive, its own
    PROPOSED entry. Say so in a comment.
  - Check that `POST /pages/:id/consolidate` cannot make a PROPOSED entry be
    served.
- **KG-0.3:** Move the needs-decision check into `createEntry` (or a guard it
  calls) so REST, MCP and CLI all get it. Keep the agent-core behaviour as a
  thin client of it.
- **KG-0.4:** `@RequiresScope('read')` on read-through-POST knowledge routes.
- **KG-0.5:** Debounce the knowledge search query in the search dialog.
- **KG-0.6:** Decay reads `lastServedAt`, not only `retrievalCount`.

### Phase 1: Connect knowledge to the product graph

This gives later phases a neighbourhood (for duplicate checks) and a
repository (for grounding).

- **KG-1.1:** Add `PRODUCT`, `MODULE` and `CAPABILITY` to `PageLinkType`
  (schema, migration, `packages/types/src/page/page.entity.ts`), and resolve
  them in `page-links.service.ts`.
- **KG-1.2:** `PageEntry.moduleIds String[]`.
  - Resolve with `modulesForChangedPaths` against the workspace's
    `ModuleRepo` rows.
  - Recompute on scope change, and when module repos change (a job on the
    pages queue is fine).
  - Index as a Typesense facet.
  - A scope that is not a path (a team or project name) resolves to no
    modules. That is allowed.
- **KG-1.3:** Prefix matching.
  - Index each entry's scope ancestors (`apps`, `apps/server`,
    `apps/server/prisma`) as an array facet and filter on the query path's
    ancestors, or an equivalent that stays a Typesense filter.
  - Unscoped entries and page bodies remain eligible, ranked lower.
- **KG-1.4:** `PageEntry.kind` enum (FACT default, DECISION, CONVENTION,
  GOTCHA). Update the skill with one line on when each applies.
- **KG-1.5:** Seeding from `moduleIds` or `issueId` (via `Issue.moduleIds`
  and `Issue.capabilityId`). Expand one hop to:
  - the module's owning product;
  - capabilities whose `moduleIds` contain it;
  - the product's other modules, as a weaker boost.

  Use it as a boost in the Typesense query, not a hard filter, so good
  unscoped matches still surface.
- **KG-1.6:** MCP enums and descriptions, agent-core and CLI types, and a
  Knowledge section on `/product/[key]`, `/module/[key]` and
  `/capability/[id]` listing linked pages and resolved standing entries.

### Phase 2: Ground facts in code

- **KG-2.1:** Add a `PageEntryCitation` model. A shape to start from:

  ```prisma
  model PageEntryCitation {
    id          String   @id @default(uuid())
    createdAt   DateTime @default(now())
    updatedAt   DateTime @updatedAt
    entry       PageEntry @relation(fields: [entryId], references: [id])
    entryId     String
    kind        PageEntryCitationKind   // CODE | ISSUE | PULL_REQUEST | COMMENT | RUN
    // CODE
    moduleRepoId String?
    path         String?
    commitSha    String?
    startLine    Int?
    endLine      Int?
    snippet      String?  // the cited lines as written, whitespace-normalised for matching
    snippetHash  String?
    // non-code
    targetId     String?
    // last check
    checkedAt    DateTime?
    checkedSha   String?
    checkResult  PageEntryCitationCheck?  // HOLDS | MOVED | CHANGED | MISSING | UNKNOWN
    @@index([entryId])
    @@index([moduleRepoId, path])
  }
  ```

  - `remember` takes `citations: [{ path, sha, lines: "40-52" } | { issue } | { pullRequest } | { comment } | { run }]`.
  - The server fills in `snippet` itself from the file at that SHA. It never
    trusts a snippet the agent supplies.
- **KG-2.2:** Check at write. A citation that does not hold refuses the write
  (422) with the failing citation named, the way `remember` already refuses
  lists.
- **KG-2.3:** A `RepoFileSource` interface: `read(moduleRepo, path, ref) →
  { content } | { missing } | { unknown, reason }`.
  - GitHub: the contents API with the integration's installation token
    (`integrations/github/get-token.ts`).
  - Local-repo: `git show <ref>:<path>` in the configured checkout.
  - Choose by `ModuleRepo.integrationAccountId`.
  - Resolving `HEAD` of the default branch is part of the interface.
- **KG-2.4:** Relocation.
  - Exact snippet at the cited lines → HOLDS.
  - Exact (normalised) snippet elsewhere → MOVED, with the new range.
  - Otherwise → CHANGED.
  - File absent → MISSING.
- **KG-2.5:** The judge prompt gets the claim, the old snippet and the current
  file region around the old location, and returns `holds | contradicted |
  unclear` with line numbers.
  - Default the judge to the `smart` role. Where the writer's model is known
    (a hosted run records it), prefer the role that is not it.
  - Store the model name on the check.
- **KG-2.6:** Existence checks through Prisma, scoped to the workspace.
- **KG-2.7:** Trust tier.
  - Derived: `verifiedAt` set → HUMAN_VERIFIED; STANDING with every citation
    HOLDS or MOVED and no human verification → GROUNDED; else UNGROUNDED.
  - Index `trust` as a facet and sort with `_eval` so verified > grounded >
    ungrounded before `retrievalCount`.
- **KG-2.8:** One serializer for served items, used by every path.

### Phase 3: Record use and outcomes

- **KG-3.1:** Add a `PageEntryUse` table.
  - Write rows where `recordDemand` runs, and in the context pack. Batch the
    inserts.
  - MCP calls carry the session and token; hosted runs carry `agentRunId`.
- **KG-3.2:** The context pack's knowledge section.
  - CONVENTION entries resolved to the issue's modules first, then the top
    `KNOWLEDGE_CONTEXT_TOP_K` relevant GROUNDED or HUMAN_VERIFIED entries
    (seeded retrieval from phase 1), within a token budget.
  - Render the citation and age in `agent-prompt.ts`.
  - Record uses with `via: CONTEXT_PACK`.
- **KG-3.3:** `AgentRun.knowledgeArm` (`treatment | holdout`), from a hash of
  the run id against `KNOWLEDGE_HOLDOUT_RATE`. A holdout run gets an empty
  knowledge section and records no uses.
- **KG-3.4:** Add `PageEntry.helpfulCount` and `harmfulCount` (or a signals
  table, if you want history). Attribute on the run's terminal transition.
  - Evidence paths come from `ReviewFinding.evidence` (`file:line`) and
    failing verification commands.
  - "Under the entry" means the path falls within one of its code citations'
    files, or within its scope prefix.
  - A harmful signal enqueues a citation re-check (phase 2).
- **KG-3.5:** Hook `pr-sync.ts`'s merged and closed handling to the run that
  produced the pull request.
- **KG-3.6:** An aggregation service with a test on fixed data, plus a panel
  in Settings → Agents. Show the sample size prominently; small arms mean
  noisy numbers.

### Phase 4: LLM-first triage

- **Pipeline on the pages queue,** one job per new entry, idempotent per entry
  id:
  1. policy (secrets, one-fact rule, external input);
  2. exact duplicate;
  3. neighbourhood relations;
  4. grounding;
  5. decision.
- **Store each decision** in a `KnowledgeTriageDecision` table: entry,
  decision, reasons, inputs digest, models, raw model output, mode (shadow or
  on), and the later human verdict. It is the audit trail and the data for
  phase 5.
- **Relations** go in a `PageEntryRelation` table (from, to, type, decidedBy).
  The existing `supersedesId` stays the way a supersede is expressed.
- **Similarity threshold:** start from the vector distance `similarEntries`
  uses, and read `SIMILARITY_MEASUREMENT_NOTE` in `vector.interface.ts`. Make
  the threshold a setting.
- **"Two independent judgments agree"** (KG-4.4): the same question to the
  `fast` and `smart` roles, or twice to one role at a non-zero temperature.
  Disagreement escalates.
- **Escalation reasons** are an enum: `CONTRADICTS_VERIFIED`,
  `CONTRADICTS_LOCKED`, `UNGROUNDED`, `CITATION_FAILED`, `PIN_REQUEST`,
  `BROAD_SCOPE`, `JUDGES_DISAGREE`, `NO_LLM`, `EXTERNAL_INPUT`,
  `HARMFUL_SIGNAL`, `AUDIT`.
- **Shadow mode is the default.** In shadow mode, write the decision and
  leave the status. The maintainer compares shadow decisions with human
  triage before switching to `on`.

### Phase 5: Escalation and audit

- **KG-5.1:** The review queue lists escalations with their reason labels,
  plus audit items. It reuses `review-queue.tsx` with a reason facet.
- **KG-5.2:** The audit draw is seeded by decision id, so it is reproducible
  in tests.
- **KG-5.3:** Cohen's kappa over (triage decision, human verdict) pairs per
  decision type, over a rolling window (a setting, default 30 days). Unit
  test it against hand-computed values, including perfect agreement,
  chance-level agreement and a degenerate single-class case.
- **KG-5.4:** Back-off state per workspace and decision type, stored and
  logged, re-evaluated as verdicts arrive.
- **KG-5.5:** Queue actions write the verdict onto the decision row.

### Phase 6: Keep knowledge true over time

- **KG-6.1:** Widen `parsePullRequestEvent` handling so a merged pull request
  produces a code-change event even without issue keys. Add `mergeSha` to
  `CodeChangeEvent`. Keyed routing stays as it is. Add pushes to the default
  branch if the integration receives them.
- **KG-6.2:** Find citations by `(moduleRepoId, path)` over the changed paths,
  and re-check each against the merge SHA.
  - The correction issue goes to the team that owns the module (or its
    product's default team), labelled `knowledge`, and cites the entry and
    the change. It is not delegated automatically; a person or an existing
    automation decides.
- **KG-6.3:** Group findings by module (from the evidence path) and by
  similarity of message.
  - A candidate needs `KNOWLEDGE_CONVENTION_MIN_RUNS` distinct runs.
  - Pinning means marking a CONVENTION as always included in its modules'
    context packs; that is the `PIN_REQUEST` escalation.
  - Auto-disable (ARCHIVED with a reason) when harmful signals outnumber
    helpful ones by a set margin. This is reversible by a person.
- **KG-6.4:** Gap issues use a deterministic title and store the gap id, so a
  second run finds the first issue. A gap is answered when an accepted entry
  cites that issue.
- **KG-6.5:** Replace the decay rule as the criterion describes. Keep
  `PAGE_DECAY_CRON`.

### Phase 7: Gated generated pages

Build this last.

- **KG-7.1:** `Page.kind` (AUTHORED default, GENERATED), `Page.question`, and
  sections with stable ids that cite entry ids.
- **KG-7.2:** Watermark: the latest `updatedAt` among entries in the page's
  scope and links. Refresh when it advances and
  `KNOWLEDGE_PAGE_REFRESH_MIN_INTERVAL` has passed.
- **KG-7.3:** Operations `replace_section | insert_section | remove_section`
  with section ids. Apply them in code: untouched sections are copied
  byte-for-byte, and an unknown id drops that operation.
- **KG-7.4:** Change consolidation.
  - Entries a page cites keep being served as evidence, ranked below the page
    for the same match.
  - `consolidate_knowledge` on an AUTHORED page produces a proposal for a
    human, not an edit.
- **KG-7.5:** PageHistory with `previousBody` on every refresh; the existing
  revert works.
- **KG-7.6:** A user-facing docs page, `apps/docs/docs/fundamentals/knowledge.mdx`,
  and the updated agent guide.

---

## 5. Settings added by this plan

| Variable | Default | Meaning |
|---|---|---|
| `KNOWLEDGE_AUTO_TRIAGE` | `shadow` | `off`, `shadow` (decide and record, do not act) or `on` |
| `KNOWLEDGE_AUDIT_RATE` | `0.1` | Share of auto-accepted decisions sent to a human as audits |
| `KNOWLEDGE_KAPPA_FLOOR` | `0.6` | Below this, a decision type escalates instead of acting |
| `KNOWLEDGE_KAPPA_MIN_SAMPLES` | `20` | Verdicts needed before the floor applies |
| `KNOWLEDGE_HOLDOUT_RATE` | `0.1` | Share of hosted runs given no knowledge |
| `KNOWLEDGE_CONTEXT_TOP_K` | `5` | Relevant entries in a run's context pack, after conventions |
| `KNOWLEDGE_CONVENTION_MIN_RUNS` | `3` | Distinct runs before recurring findings become a candidate convention |
| `KNOWLEDGE_GAP_ISSUES_CRON` | weekly | Opens issues for top knowledge gaps; `off` disables |
| `KNOWLEDGE_PAGE_REFRESH_MIN_INTERVAL` | `6h` | Minimum time between generated-page refreshes |

Each also reads a per-workspace override from
`Workspace.preferences.knowledge`.

---

## 6. Not in this plan

The evidence argues against these. Do not build them:

- **LLM entity/relation extraction** into a knowledge graph (GraphRAG,
  LightRAG or Graphiti-style ingestion), or a separate graph database.
- **Confidence scores produced by an LLM.** Hindsight itself removed them in
  April 2026.
- **Generated per-module AGENTS.md files** served to every session.
- **Any LLM rewrite of a whole page body,** or edits to AUTHORED pages
  without a human.
- **Deleting knowledge on an outcome signal.**

---

## 7. References

- GitHub, *Building an agentic memory system for Copilot*: https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/
- Cursor, *Bugbot learned rules*: https://cursor.com/blog/bugbot-learning
- *ACE: Agentic Context Engineering*: https://arxiv.org/abs/2510.04618 (code: https://github.com/ace-agent/ace)
- *ReasoningBank*: https://arxiv.org/abs/2509.25140
- Xiong et al., *How Memory Management Impacts LLM Agents*: https://arxiv.org/abs/2505.16067
- *Useful Memories Become Faulty When Continuously Updated by LLMs*: https://arxiv.org/abs/2605.12978
- Gloaguen et al., *Evaluating AGENTS.md*: https://arxiv.org/abs/2602.11988
- *Trust or Escalate*: https://arxiv.org/abs/2407.18370
- *Judging the Judges*: https://arxiv.org/abs/2406.12624
- *Judge-Bench*: https://arxiv.org/abs/2406.18403
- Huang et al., *LLMs cannot self-correct reasoning yet*: https://arxiv.org/abs/2310.01798
- Stechly et al., *GPT-4 doesn't know it's wrong*: https://arxiv.org/abs/2402.08115
- *MemoryAgentBench*: https://arxiv.org/abs/2507.05257
- *GraphRAG-Bench*: https://arxiv.org/abs/2506.05690
- LinkedIn, *RAG with knowledge graphs for customer service*: https://arxiv.org/abs/2404.17723
- Chroma, *Context rot*: https://www.trychroma.com/research/context-rot
- MINJA: https://arxiv.org/abs/2503.03704
- AgentPoison: https://arxiv.org/abs/2407.12784
- Hindsight: https://github.com/vectorize-io/hindsight
- Graphiti: https://github.com/getzep/graphiti
- Mem0 v3 migration: https://github.com/mem0ai/mem0/blob/main/docs/migration/oss-v2-to-v3.mdx
