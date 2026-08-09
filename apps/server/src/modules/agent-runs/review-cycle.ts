import type { AgentRunLimits } from '@vantikhq/types';

import { createHash } from 'node:crypto';

import {
  AGENT_RUN_DEFAULT_LIMITS,
  AGENT_RUN_DEFAULT_MAX_CYCLES,
} from '@vantikhq/types';

/**
 * The implement → verify → review → revise cycle, as decisions rather than as
 * plumbing.
 *
 * Kept here, away from the executor, because these are the parts worth being
 * able to test without booting a microVM: when the loop stops, what a review
 * finding has to carry to be read at all, and which ceiling a run hit. The
 * executor is the part that runs commands; this is the part that decides what
 * running them meant.
 *
 * Four rules shape it, and each one is a failure mode somebody has already
 * measured:
 *
 * 1. **No opinion counts until something has been run.** Self-correction over a
 *    diff, with no execution-grounded signal, measures flat to negative on code
 *    generation — and challenging a correct answer makes models abandon it. So
 *    the repository's own checks run *before* the reviewer is asked anything,
 *    and their result goes into the reviewer's prompt as fact.
 * 2. **A finding without evidence is taste.** A reviewer that cannot point at a
 *    `file:line` or a command that fails is the intrinsic self-correction from
 *    (1) wearing a hat. Those findings are dropped unread rather than sent back
 *    to the implementer, who would dutifully churn on them.
 * 3. **More passes is not more quality.** The baseline to beat is one agent
 *    with the same total budget iterating against the test suite, so the cycle
 *    is capped and the cap is low.
 * 4. **A loop that stops changing has stopped working.** Without an oscillation
 *    check, a critic-driven loop spends its whole budget rewording the same
 *    function and reports the ceiling as though it were the problem.
 */

/** Where the reviewer writes its verdict, absolute inside the guest. */
export function reviewVerdictPath(pass: number): string {
  return `/workspace/review-${pass}.json`;
}

/**
 * One thing the reviewer says is wrong, once it has earned the right to be read.
 *
 * `evidence` is not decoration and not optional in practice — see
 * `keepEvidenced`. `criterion` points back at a numbered Definition of Done
 * item when the finding is about one, which is what lets the revision prompt
 * say *which* bar the work is missing rather than just that it is.
 */
export interface ReviewFinding {
  message: string;
  /** `src/thing.ts:42`, or a command in backticks that fails. */
  evidence?: string;
  severity?: 'low' | 'medium' | 'high';
  criterion?: number;
}

export interface ReviewVerdict {
  /** Whether the reviewer would let this diff go to a human as it stands. */
  accepted: boolean;
  findings: ReviewFinding[];
  /** The reviewer's own prose, for the record and for the revision prompt. */
  summary?: string;
}

/**
 * How many findings are carried into the next pass.
 *
 * A reviewer handed a large diff will happily produce forty items, and an
 * implementer handed forty items addresses the easy ones. Capping at the
 * highest severity first keeps the next pass pointed at what actually blocks
 * the work.
 */
export const MAX_FINDINGS = 12;

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * The reviewer's verdict file, read defensively.
 *
 * Returns null rather than throwing on anything it cannot make sense of. The
 * file is written by a model, so a missing file, a fenced code block around the
 * JSON, a truncated object and a bare array are all normal — and a parser that
 * dies on one costs the run a whole pass to report a formatting complaint.
 *
 * A verdict that cannot be read is *not* treated as acceptance anywhere
 * downstream. The caller hands over to a human instead, because "the reviewer
 * did not answer" and "the reviewer said yes" must never collapse into the same
 * outcome.
 */
export function parseReviewVerdict(raw: string | null): ReviewVerdict | null {
  if (!raw?.trim()) {
    return null;
  }

  // A model told to write JSON writes JSON in a fence about a third of the
  // time. Cheaper to accept it than to spend a pass insisting.
  const unfenced = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');

  if (start === -1 || end <= start) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  // Only an explicit boolean true is acceptance. `"accepted": "no"` is a
  // non-empty string and therefore truthy, which is how a reviewer saying no
  // would be recorded as a yes.
  const accepted = record.accepted === true;

  return {
    accepted,
    findings: findingsOf(record.findings),
    ...(typeof record.summary === 'string' && record.summary.trim()
      ? { summary: record.summary.trim().slice(0, 4000) }
      : {}),
  };
}

function findingsOf(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): ReviewFinding[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const message =
      typeof record.message === 'string'
        ? record.message.trim()
        : typeof record.title === 'string'
          ? record.title.trim()
          : '';

    if (!message) {
      return [];
    }

    const severity =
      typeof record.severity === 'string' &&
      record.severity.toLowerCase() in SEVERITY_RANK
        ? (record.severity.toLowerCase() as ReviewFinding['severity'])
        : undefined;

    const criterion =
      typeof record.criterion === 'number' && Number.isInteger(record.criterion)
        ? record.criterion
        : undefined;

    return [
      {
        message: message.slice(0, 1000),
        ...(typeof record.evidence === 'string' && record.evidence.trim()
          ? { evidence: record.evidence.trim().slice(0, 500) }
          : {}),
        ...(severity ? { severity } : {}),
        ...(criterion ? { criterion } : {}),
      },
    ];
  });
}

/**
 * A `file:line`, or a command in backticks. Anything else is prose.
 *
 * Deliberately mechanical. The point is not to judge whether the evidence is
 * *good* — no regular expression can — but to make the reviewer do the work of
 * going and looking, because a reviewer that has opened the file writes a
 * different finding from one that has only read a diff.
 */
const EVIDENCE = /(^|\s)[\w./-]+\.[a-z]{1,5}:\d+|`[^`]+`/i;

/**
 * Drops findings that cite nothing, and keeps the worst of what is left.
 *
 * Sorted by severity before the cap so a truncated list loses the nitpicks
 * rather than the blocker. Findings with no stated severity sort as medium:
 * a reviewer that did not say is not thereby saying "low".
 */
export function keepEvidenced(
  findings: ReviewFinding[],
  cap = MAX_FINDINGS,
): ReviewFinding[] {
  return findings
    .filter((finding) => finding.evidence && EVIDENCE.test(finding.evidence))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity ?? 'medium'] ?? 1) -
        (SEVERITY_RANK[b.severity ?? 'medium'] ?? 1),
    )
    .slice(0, cap);
}

/** What one pass of the cycle turned out to be. */
export interface CyclePass {
  /** 1-based. */
  index: number;
  /**
   * Whether the repository's own checks passed. Null when the repository
   * declared none, which is a different fact from failing them.
   */
  verificationPassed: boolean | null;
  /** The reviewer's answer, or null when it did not give a readable one. */
  accepted: boolean | null;
  findings: ReviewFinding[];
  /**
   * A content hash of the working tree, for the oscillation check. Null when
   * the guest could not produce one — the check is then skipped rather than
   * guessed at.
   */
  diffHash: string | null;
}

export interface CycleLimits {
  maxCycles: number;
  maxCostUsd: number;
  /** Epoch milliseconds. The whole run's wall clock, not one pass's. */
  deadlineAt: number;
}

export interface CycleSpend {
  costUsd: number;
  /** Assistant turns across every harness invocation this run has made. */
  turns: number;
}

export type CycleDecision =
  /** The reviewer is satisfied. Deliver it. */
  | { action: 'accept'; reason: string }
  /** Hand the findings back to an implementer and go round again. */
  | { action: 'revise'; reason: string }
  /**
   * Stop, and deliver what exists for a person to judge. Never a failure: the
   * work is real, it just has not been signed off by anything.
   */
  | { action: 'handOver'; reason: string };

export interface DecideCycleInput {
  history: CyclePass[];
  spend: CycleSpend;
  limits: CycleLimits;
  /** Injected so the decision is testable without waiting for a clock. */
  now: number;
}

/**
 * Whether to accept, revise, or stop and fetch a human.
 *
 * The order of these checks is the design. Acceptance is tested first and
 * costs nothing, so a run that finished on its last affordable pass is still
 * allowed to finish rather than being reported as out of budget. Everything
 * after it is a reason to stop *without* an answer, and each says which ceiling
 * it hit — "it stopped" is not a finding, and the reason is read by whoever has
 * to decide what to do next.
 */
export function decideCycle(input: DecideCycleInput): CycleDecision {
  const { history, spend, limits, now } = input;
  const latest = history[history.length - 1];

  if (!latest) {
    return { action: 'revise', reason: 'Nothing has run yet.' };
  }

  // Acceptance needs the reviewer *and* the checks to agree. A reviewer that
  // signs off a tree whose tests are failing has contradicted something that
  // was actually executed, and the executed thing wins.
  if (latest.accepted === true && latest.verificationPassed !== false) {
    return {
      action: 'accept',
      reason:
        latest.findings.length === 0
          ? 'The reviewer found nothing to fix.'
          : `The reviewer accepted the work with ${latest.findings.length} non-blocking note(s).`,
    };
  }

  // What the reviewer did or did not say comes before any ceiling, and only
  // because of what the reason string is for. Every branch from here down stops
  // the run, so the order changes no behaviour — but a run whose reviewer said
  // nothing readable, reported as "it hit the pass limit", tells a person the
  // work was reviewed three times and is nearly there. It was not reviewed at
  // all, and that is the more alarming of the two facts.
  if (latest.accepted === null) {
    return {
      action: 'handOver',
      reason:
        'The reviewer did not produce a verdict that could be read, so ' +
        'nothing has checked this diff.',
    };
  }

  // A rejection with no evidence behind it is the same situation: the reviewer
  // said no and could not say where. Sending that back produces churn.
  if (latest.findings.length === 0) {
    return {
      action: 'handOver',
      reason:
        'The reviewer rejected the work but cited no file, line or failing ' +
        'command, so there is nothing specific to send back.',
    };
  }

  if (spend.costUsd >= limits.maxCostUsd) {
    return {
      action: 'handOver',
      reason: `The run had spent $${spend.costUsd.toFixed(2)}, which is the limit for this issue.`,
    };
  }

  if (now >= limits.deadlineAt) {
    return {
      action: 'handOver',
      reason: 'The run reached its wall-clock limit for this issue.',
    };
  }

  if (history.length >= limits.maxCycles) {
    return {
      action: 'handOver',
      reason:
        `The work went through ${history.length} review pass(es), which is the ` +
        `limit. An issue that is still not right after that usually needs ` +
        `splitting rather than another pass.`,
    };
  }

  const previous = history[history.length - 2];

  // Two passes that changed neither the tree nor the verification state means
  // the implementer is not acting on the findings — either because it cannot or
  // because it disagrees. A third identical pass is not new information.
  if (
    previous &&
    latest.diffHash !== null &&
    latest.diffHash === previous.diffHash &&
    latest.verificationPassed === previous.verificationPassed
  ) {
    return {
      action: 'handOver',
      reason:
        'Two passes in a row changed neither the working tree nor the ' +
        'verification result, so another pass would change nothing either.',
    };
  }

  return {
    action: 'revise',
    reason: `${latest.findings.length} finding(s) to address.`,
  };
}

/**
 * The ceilings this run is held to, resolved once at the top of the cycle.
 *
 * Resolved rather than read per pass so the numbers cannot drift mid-run, and
 * so the reason a run stopped quotes the ceiling it was actually held to.
 */
export function resolveCycleLimits(
  limits: AgentRunLimits | undefined,
  startedAt: number,
): CycleLimits {
  return {
    maxCycles: positive(limits?.maxCycles) ?? AGENT_RUN_DEFAULT_MAX_CYCLES,
    maxCostUsd:
      positive(limits?.maxCostUsd) ?? AGENT_RUN_DEFAULT_LIMITS.maxCostUsd,
    deadlineAt:
      startedAt + (positive(limits?.maxDurationMs) ?? DEFAULT_DURATION_MS),
  };
}

/** The wall clock a hosted run gets when nobody sets one. */
export const DEFAULT_DURATION_MS = 30 * 60 * 1000;

/**
 * Below this there is not enough time left to be worth starting a model call.
 *
 * A harness given ninety seconds spends them booting and is killed mid-edit,
 * which leaves a half-applied change in the tree — strictly worse than stopping
 * with the previous pass's work intact.
 */
export const MIN_USEFUL_MS = 90 * 1000;

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function hashOf(contents: string): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

/**
 * The event phase one step of one pass belongs to.
 *
 * The first pass uses the bare names, so a run that never needed reviewing
 * reads exactly as it did before this loop existed. Later passes carry their
 * number, which is what stops the timeline merging pass three's edits into
 * pass one's.
 */
export function phaseName(base: string, pass: number): string {
  return pass <= 1 ? base : `${base}-${pass}`;
}
