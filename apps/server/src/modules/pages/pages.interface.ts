import { type PageEntryUseVia } from '@prisma/client';
import { PageEntryStatusEnum } from '@vantikhq/types';
import type { JobOptions } from 'bull';

/**
 * The mechanical limits on writing to the knowledge bank.
 *
 * These are *not* the curation opinion. That lives in the MCP tool layer, which
 * is the only surface allowed to editorialise — the CLI and the REST API stay
 * neutral, exactly as they do for issues. What lives here is arithmetic: how
 * many untriaged claims one token may leave on one page, and how long unread
 * knowledge sits before it stops being anyone's problem.
 *
 * The reason they are server-side is that a tool description asking for
 * restraint is advisory. It fails precisely when a cheaper or unfamiliar model
 * is pointed at the endpoint, which is the cross-harness case the bank exists
 * to serve.
 */

/**
 * Untriaged entries one token may leave on one curated page.
 *
 * Per token rather than per account: an account can hold several tokens, and a
 * budget spent per account would let one noisy harness exhaust the allowance of
 * every other harness signed in as the same agent.
 */
export const PROPOSED_ENTRY_BUDGET = Number(
  process.env.PAGE_PROPOSED_ENTRY_BUDGET ?? 10,
);

/**
 * How long an untriaged entry waits before it archives itself.
 *
 * An unbounded inbox is what actually overwhelms a person: fifty rows nobody
 * will ever read is the same as no review surface at all.
 */
export const PROPOSED_ENTRY_EXPIRY_DAYS = Number(
  process.env.PAGE_PROPOSED_ENTRY_EXPIRY_DAYS ?? 30,
);

/**
 * How long a standing entry may go unserved before it archives itself. Unused
 * knowledge is by definition not load-bearing.
 */
export const STANDING_ENTRY_DECAY_DAYS = Number(
  process.env.PAGE_STANDING_ENTRY_DECAY_DAYS ?? 90,
);

/**
 * When the decay pass runs. Empty or `off` disables it entirely.
 *
 * Both windows above are dormant without this — a deployment that trusts decay
 * to keep the bank small is trusting nothing until something calls the pass.
 * Nightly rather than hourly because the windows are measured in weeks: running
 * it more often changes what is archived not at all, and only costs a scan.
 */
export const DECAY_CRON = process.env.PAGE_DECAY_CRON ?? '0 3 * * *';

/** The queue and job the decay pass runs under. */
export const PAGES_QUEUE = 'pages';
export const DECAY_JOB = 'runDecay';

/**
 * A fixed id for the repeatable job.
 *
 * Every replica registers the schedule at boot, so without a stable id each one
 * would add its own copy and the pass would run once per replica per night —
 * harmless in effect, since archiving twice is idempotent, but it makes the
 * queue unreadable and the logs lie about how often the bank is being groomed.
 */
export const DECAY_JOB_ID = 'page-entry-decay';

/**
 * When the gardener opens issues for the questions the knowledge keeps
 * failing to answer. Empty or `off` disables it. Weekly, because a gap is
 * demand counted over weeks, and an issue a week per question is as fast as
 * a team can be asked to answer them.
 */
export const GAP_ISSUES_CRON =
  process.env.KNOWLEDGE_GAP_ISSUES_CRON ?? '0 4 * * 1';

/** The job that opens them, with a fixed id for the reason decay has one. */
export const GAP_ISSUES_JOB = 'openKnowledgeGapIssues';
export const GAP_ISSUES_JOB_ID = 'knowledge-gap-issues';

/**
 * Looks for generated pages whose evidence has changed, and rebuilds each
 * one due: see `generated/page-refresh.service.ts`. Hourly by default, as a
 * page is rebuilt no sooner than its workspace's minimum interval anyway;
 * `off` disables it, and a generated page is then built only when it is made
 * or its question changes (once the minimum interval has passed).
 */
export const PAGE_REFRESH_CRON =
  process.env.KNOWLEDGE_PAGE_REFRESH_CRON ?? '23 * * * *';

/** The job that looks, with a fixed id for the reason decay has one. */
export const PAGE_REFRESH_JOB = 'refreshGeneratedPages';
export const PAGE_REFRESH_JOB_ID = 'generated-page-refresh';

/**
 * Builds one generated page, when it is made or its question changes, so it
 * is not left empty until the next look. The gate still applies: after a
 * question change the job waits out the minimum interval since the last
 * build (`delay`), rather than running early and finding the page too soon.
 */
export const REFRESH_PAGE_JOB = 'refreshGeneratedPage';

/** One job per page at a time; a request while one waits is the same request. */
export function refreshPageJobOptions(pageId: string, delay = 0): JobOptions {
  return {
    jobId: `${REFRESH_PAGE_JOB}:${pageId}`,
    ...(delay > 0 ? { delay } : {}),
    attempts: 2,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: 20,
  };
}

/**
 * Re-resolves entries' scopes to modules. Queued with a workspace id when a
 * module's repositories change, and once at boot with none, which covers every
 * workspace and fills in entries written before modules were resolved.
 */
export const RECOMPUTE_MODULES_JOB = 'recomputeEntryModules';

/** How long requests to re-resolve one workspace are gathered into one pass. */
export const RECOMPUTE_MODULES_WINDOW_MS = 5_000;

/**
 * How long after its window a pass waits before it starts. The window is read
 * from the clock of the server that queued the request, and the pass is
 * started by the worker's clock; the grace absorbs any disagreement smaller
 * than itself.
 */
export const RECOMPUTE_MODULES_GRACE_MS = 1_000;

/**
 * Queue options that fold a burst of recompute requests into one pass.
 *
 * Every request in the same window gets the same job id, and Bull ignores a
 * job whose id is already queued, so a run of repository edits, or replicas
 * booting together, queue one pass. The job waits until its window has closed
 * (plus a grace, for servers whose clocks disagree by less than it), which is
 * what makes the folding safe: a request cannot find its pass already running
 * and be dropped. A request that comes later falls in a later window and gets
 * a pass of its own, which reads the state after its edit. A fixed id would
 * not do that; it would swallow every request made while the pass ran, and
 * every one after a failed pass kept for inspection.
 */
export function recomputeModulesJobOptions(
  workspaceId: string | undefined,
  now: number = Date.now(),
): JobOptions {
  const window = Math.floor(now / RECOMPUTE_MODULES_WINDOW_MS);

  return {
    jobId: `${RECOMPUTE_MODULES_JOB}:${workspaceId ?? 'all'}:${window}`,
    delay:
      (window + 1) * RECOMPUTE_MODULES_WINDOW_MS +
      RECOMPUTE_MODULES_GRACE_MS -
      now,
    removeOnComplete: true,
    removeOnFail: 20,
  };
}

/**
 * Reads again the code citations an entry was written with that the server
 * could not read at the time, because the repository did not answer.
 */
export const RETRY_CITATIONS_JOB = 'retryUnknownCitations';

/** How many times an entry's unread citations are tried before giving up. */
export const RETRY_CITATIONS_ATTEMPTS = 6;

/** The first retry's wait; each later one waits twice as long as the last. */
export const RETRY_CITATIONS_BACKOFF_MS = 5 * 60_000;

/**
 * One retry per entry: a second write naming the same entry cannot exist, and
 * a job already queued for it reads every unread citation it has. Bull's own
 * backoff spaces the attempts, so a repository down for an hour is read once
 * it is back, and one down for good stops being asked after about five hours.
 * A citation that is never read stays UNKNOWN, which never counts against the
 * entry.
 */
export function retryCitationsJobOptions(entryId: string): JobOptions {
  return {
    jobId: `${RETRY_CITATIONS_JOB}:${entryId}`,
    attempts: RETRY_CITATIONS_ATTEMPTS,
    backoff: { type: 'exponential', delay: RETRY_CITATIONS_BACKOFF_MS },
    delay: RETRY_CITATIONS_BACKOFF_MS,
    removeOnComplete: true,
    removeOnFail: 20,
  };
}

/**
 * Checks an entry's citations again, because a run it was served to went
 * wrong somewhere it speaks about. A harmful signal is a reason to look, not
 * a verdict: the check decides whether the entry still holds, and nothing is
 * archived for what it finds. The same job weighs the outcomes of a
 * convention the gardener proposed, the one entry outcomes can take out of
 * use: see `upkeep/knowledge-conventions.service.ts`.
 */
export const RECHECK_ENTRY_JOB = 'recheckEntryCitations';

/**
 * One queued check per entry: several runs going wrong over the same entry
 * before the check runs need it checked once. Removed when done or failed, so
 * the next harmful signal can queue another.
 */
export function recheckEntryJobOptions(entryId: string): JobOptions {
  return {
    jobId: `${RECHECK_ENTRY_JOB}:${entryId}`,
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/**
 * Checks the knowledge citing the files a change touched, once the change has
 * landed on a repository's default branch: see `upkeep/knowledge-upkeep.service.ts`.
 */
export const CODE_LANDED_JOB = 'recheckLandedChange';

/** A change that landed, as the job that checks its knowledge is given it. */
export interface CodeLandedJob {
  workspaceId: string;
  externalRepoId: string;
  /** The commit it landed as, which the citations are read at. */
  sha: string;
  changedPaths: string[];
  /**
   * For a citation handed on after its first reading: the commit it was
   * read at. The check is then of every change since, which the head holds,
   * and not of one change that landed as `sha`.
   */
  since?: string;
  /**
   * For a citation handed on after its first reading: only it is checked.
   * The other citations of its file were checked by the changes' own jobs,
   * and `since` is not the commit they were read at.
   */
  citationIds?: string[];
}

/**
 * One check per commit. A merged pull request and the push that lands its
 * merge commit both report the same commit, and need it checked once; a
 * citation already checked at that commit is not read again either, unless
 * a person has put its entry back or reworded it since. Tried again when a
 * repository could not be read, as a rate limit or an outage clears on its
 * own, and when a person acted on an entry after its citations were read,
 * so they are read again.
 */
export function codeLandedJobOptions(job: CodeLandedJob): JobOptions {
  return {
    jobId: `${CODE_LANDED_JOB}:${job.workspaceId}:${job.externalRepoId}:${job.sha}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: 20,
  };
}

/**
 * Records the review findings of a finished run, and proposes a convention
 * for any the reviewer has now given in enough runs: see
 * `upkeep/knowledge-conventions.service.ts`.
 */
export const RUN_FINDINGS_JOB = 'recordRunFindings';

/**
 * One job per run, since a run ends once. Tried again when it fails: the
 * findings are recorded once whatever the number of tries, and a proposal
 * that could not be written is written by the next.
 */
export function runFindingsJobOptions(runId: string): JobOptions {
  return {
    jobId: `${RUN_FINDINGS_JOB}:${runId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: 20,
  };
}

/**
 * Decides what becomes of a new entry before a person looks at it: see
 * `triage/knowledge-triage.service.ts`.
 */
export const TRIAGE_ENTRY_JOB = 'triageEntry';

/** How many times a triage pass is tried before the entry waits for a person. */
export const TRIAGE_ENTRY_ATTEMPTS = 3;

/**
 * One pass per entry, since a pass decides once and records it. Tried again
 * when it fails, which it does when the index cannot be asked for the entry's
 * neighbours: a pass that cannot look must not decide. An entry whose passes
 * all fail stays in the inbox, where a person triages it as before.
 */
export function triageEntryJobOptions(entryId: string): JobOptions {
  return {
    jobId: `${TRIAGE_ENTRY_JOB}:${entryId}`,
    attempts: TRIAGE_ENTRY_ATTEMPTS,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: 20,
  };
}

/**
 * Transitions a client may ask for.
 *
 * `SUPERSEDED` is absent as a source because it is terminal: it has been
 * replaced, and reviving it puts a fact back into circulation that the
 * workspace already decided about. `CONSOLIDATED` leads only out of use: it
 * is served as the evidence its page's body was written from, so a person
 * can take it out of use when it turns out wrong (disputed) or no longer
 * applies (archived), and putting it back makes it standing. `PROPOSED` is
 * absent as a *target* because triage does not run backwards, and
 * `SUPERSEDED` is absent as a target because it is only ever set by the
 * supersede path, which also records the pointer.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<
  PageEntryStatusEnum,
  PageEntryStatusEnum[]
> = {
  [PageEntryStatusEnum.PROPOSED]: [
    PageEntryStatusEnum.STANDING,
    PageEntryStatusEnum.DISPUTED,
    PageEntryStatusEnum.CONSOLIDATED,
    PageEntryStatusEnum.ARCHIVED,
  ],
  [PageEntryStatusEnum.STANDING]: [
    PageEntryStatusEnum.DISPUTED,
    PageEntryStatusEnum.CONSOLIDATED,
    PageEntryStatusEnum.ARCHIVED,
  ],
  [PageEntryStatusEnum.DISPUTED]: [
    PageEntryStatusEnum.STANDING,
    PageEntryStatusEnum.CONSOLIDATED,
    PageEntryStatusEnum.ARCHIVED,
  ],
  [PageEntryStatusEnum.ARCHIVED]: [
    PageEntryStatusEnum.STANDING,
    PageEntryStatusEnum.DISPUTED,
  ],
  [PageEntryStatusEnum.CONSOLIDATED]: [
    PageEntryStatusEnum.DISPUTED,
    PageEntryStatusEnum.ARCHIVED,
  ],
  [PageEntryStatusEnum.SUPERSEDED]: [],
};

/** Who is writing, resolved once at the controller boundary. */
export interface WriterIdentity {
  userId: string;
  /** Null for a browser session, which is not issued for any token. */
  tokenId: string | null;
}

/**
 * Who an entry was served to, and how. Every field but the workspace and the
 * route is known on some paths and not others: a run has no token, a browser
 * session no harness session, a recall no run.
 */
export interface ServedTo {
  workspaceId: string;
  via: PageEntryUseVia;
  agentRunId?: string | null;
  sessionId?: string | null;
  tokenId?: string | null;
  userId?: string | null;
}

/**
 * The harness session a request names, from `X-Vantik-Session`, or null.
 *
 * The MCP endpoint is stateless, so no session is carried by the protocol; a
 * harness that wants its uses traced to a session says so in this header, and
 * the MCP server passes it on to the calls it makes. Held to the same length
 * as a hook's session id, and to printable characters, since it is stored.
 */
export function harnessSessionOf(header: unknown): string | null {
  const value = Array.isArray(header) ? header[0] : header;

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 &&
    trimmed.length <= MAX_HARNESS_SESSION_LENGTH &&
    /^[\x21-\x7e]+$/.test(trimmed)
    ? trimmed
    : null;
}

export const HARNESS_SESSION_HEADER = 'x-vantik-session';

const MAX_HARNESS_SESSION_LENGTH = 200;
