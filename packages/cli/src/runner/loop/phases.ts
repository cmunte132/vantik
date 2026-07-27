import { createHash } from 'node:crypto';

/**
 * The specify-implement-score-review loop.
 *
 * The multi-phase shape is right and the obvious implementation of it is
 * flat-to-harmful, so the design here is what survives the evidence rather
 * than what the shape suggests. Four findings shaped it:
 *
 * 1. **A critic that only reads a diff is self-correction in costume.**
 *    Without an execution-grounded signal, self-correction measures flat or
 *    negative on code generation, and challenging a correct answer makes
 *    models abandon it. So no phase's opinion counts until something has been
 *    run.
 * 2. **Whatever you check becomes the target.** The moment the Definition of
 *    Done is the grading rubric it stops measuring quality and starts being
 *    gamed.
 * 3. **More agents is not more quality, compute-matched.** The baseline to
 *    beat is not "one agent, one shot" — it is one agent with the same total
 *    budget iterating against the test suite. Every phase has to earn its
 *    place against that, which is why they all ship disabled.
 * 4. **The test writer is the weakest link.** LLM-generated tests measure
 *    around 53% mutation score and weak assertions are the characteristic
 *    defect, so the cheap mechanical gate — run them on the base commit and
 *    require them to fail — is worth more than a better prompt.
 *
 * The core move is deriving the test artifact from the DoD *before*
 * implementation and freezing it. That changes when the criterion is fixed:
 * the DoD stops being reinterpretable by the party graded on it, and tests
 * written before the code cannot be shaped to fit the code.
 */

export type PhaseName = 'specify' | 'implement' | 'score' | 'review';

/**
 * Which phases a workspace runs.
 *
 * An enumerated set with on/off switches, never arbitrary phase composition.
 * If every workspace runs a different pipeline there is no comparable
 * population and this collects anecdotes at four times the token cost.
 *
 * **All default off.** The null hypothesis is that implement plus
 * deterministic verification is as good, and nothing here has beaten that
 * baseline yet.
 */
export interface PhaseFlags {
  specify?: boolean;
  score?: boolean;
  review?: boolean;
}

export const DEFAULT_PHASE_FLAGS: Required<PhaseFlags> = {
  specify: false,
  score: false,
  review: false,
};

export function resolvePhases(flags?: PhaseFlags): Required<PhaseFlags> {
  return { ...DEFAULT_PHASE_FLAGS, ...(flags ?? {}) };
}

/** A test file the specify phase produced, frozen at the moment it was written. */
export interface FrozenTest {
  path: string;
  contents: string;
  /** Which suite it belongs to. The implementer only ever sees `validation`. */
  suite: 'validation' | 'heldOut';
  /** Of `contents`, so tampering is detectable rather than a judgement call. */
  hash: string;
}

export function freeze(
  path: string,
  contents: string,
  suite: 'validation' | 'heldOut',
): FrozenTest {
  return { path, contents, suite, hash: hashOf(contents) };
}

export function hashOf(contents: string): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

/**
 * Which frozen tests the implementation touched.
 *
 * A run-level flag, not a judgement call. Weakening an assertion is the most
 * common way an implementer games a suite, and it is structurally detectable:
 * the file's hash changed. Surfaced separately in the PR body regardless of
 * whether the loop reacts to it, because a human reviewing a diff should be
 * told the tests moved.
 */
export function tamperedTests(
  frozen: FrozenTest[],
  current: Map<string, string>,
): FrozenTest[] {
  return frozen.filter((test) => {
    const now = current.get(test.path);
    return now !== undefined && hashOf(now) !== test.hash;
  });
}

export interface SuiteResult {
  passed: number;
  total: number;
}

export function passRate(result: SuiteResult): number {
  return result.total === 0 ? 0 : result.passed / result.total;
}

export interface IterationOutcome {
  index: number;
  validationPassRate: number;
  heldOutPassRate: number;
  /**
   * validation − held-out.
   *
   * The reward-hacking metric: numeric, per-iteration, and no model is asked
   * for an opinion about it. A wide gap means the implementation satisfies the
   * tests it can see without satisfying the spec.
   */
  delta: number;
  verificationPassed: boolean;
  findingCount: number;
  diffHash: string;
}

export type LoopDecision =
  | { action: 'continue' }
  | { action: 'stop'; reason: string }
  | { action: 'abort'; reason: string; needsReview: true };

export interface StopRuleInput {
  history: IterationOutcome[];
  maxIterations: number;
}

/**
 * Whether to run another pass.
 *
 * Three stop conditions and one abort, each earning its place:
 *
 * - **Green with no evidence-backed finding.** The work is done.
 * - **Budget spent.** Also a safety control, not only a cost one — more search
 *   steps can amplify hacking rather than reduce it.
 * - **Two consecutive iterations with no change in verification state.**
 *   Without an oscillation detector, a critic-driven loop spends its whole
 *   budget rewording the same function.
 * - **Δ widening while validation climbs** — the signature of optimising the
 *   proxy rather than the spec. Aborts to human review rather than continuing,
 *   because the loop is actively getting worse at the thing it is for.
 */
export function decideNext(input: StopRuleInput): LoopDecision {
  const { history, maxIterations } = input;
  const latest = history[history.length - 1];

  if (!latest) {
    return { action: 'continue' };
  }

  if (latest.verificationPassed && latest.findingCount === 0) {
    return { action: 'stop', reason: 'Verification passed with no findings.' };
  }

  const previous = history[history.length - 2];

  if (previous) {
    // Watched across iterations, not within one: a single wide gap can be a
    // hard issue, but a gap that grows while the visible score improves is
    // the implementation learning the tests.
    const deltaWidened = latest.delta > previous.delta;
    const validationClimbed =
      latest.validationPassRate > previous.validationPassRate;

    if (deltaWidened && validationClimbed) {
      return {
        action: 'abort',
        needsReview: true,
        reason:
          `The gap between the visible and held-out suites widened ` +
          `(${previous.delta.toFixed(2)} → ${latest.delta.toFixed(2)}) while ` +
          `the visible pass rate climbed. That is the signature of ` +
          `optimising the tests rather than the problem, so this needs a human.`,
      };
    }

    if (
      latest.verificationPassed === previous.verificationPassed &&
      latest.diffHash === previous.diffHash
    ) {
      return {
        action: 'stop',
        reason:
          'Two consecutive iterations changed neither the diff nor the verification state.',
      };
    }
  }

  if (history.length >= maxIterations) {
    return {
      action: 'stop',
      reason: `Reached the iteration cap (${maxIterations}).`,
    };
  }

  return { action: 'continue' };
}

/**
 * A review finding, once it has earned the right to be read.
 *
 * Evidence is mandatory. A reviewer that cannot point at a `file:line` or a
 * failing command is offering taste, and taste from a model that has read the
 * diff is the intrinsic self-correction the evidence says is flat-to-harmful.
 */
export interface Finding {
  message: string;
  /** `src/thing.ts:42`, or a command that fails. */
  evidence?: string;
  severity?: 'low' | 'medium' | 'high';
}

const EVIDENCE = /(^|\s)[\w./-]+\.[a-z]{1,5}:\d+|`[^`]+`/i;

/** Drops findings with no evidence, unread. */
export function keepEvidenced(findings: Finding[]): Finding[] {
  return findings.filter(
    (finding) => finding.evidence && EVIDENCE.test(finding.evidence),
  );
}

/**
 * Whether an issue can be pinned down with tests at all.
 *
 * Refactors, docs, infra, dependency bumps and UI polish cannot: a refactor's
 * Definition of Done is "behaviour unchanged", so the right artifact is the
 * existing suite plus characterisation tests rather than new specification
 * tests. Classifying wrongly and generating tests anyway produces exactly the
 * print-statements-called-tests failure mode.
 *
 * "Not test-specifiable" is a legitimate terminal state that routes to human
 * review — never reported as a failure, because training people to ignore a
 * category is how the category stops working.
 */
export function isTestSpecifiable(pack: {
  issue?: { title?: string; labels?: string[] };
  definitionOfDone?: Array<{ body: string }>;
}): boolean {
  const labels = (pack.issue?.labels ?? []).map((label) => label.toLowerCase());

  if (
    labels.some((label) =>
      ['refactor', 'docs', 'documentation', 'chore', 'infra', 'dependencies'].includes(
        label,
      ),
    )
  ) {
    return false;
  }

  const title = (pack.issue?.title ?? '').toLowerCase();
  if (/^(refactor|docs?|chore|bump|upgrade)\b/.test(title)) {
    return false;
  }

  // No stated criteria means nothing to derive a test from. Better to say so
  // than to invent a standard and grade against it.
  return (pack.definitionOfDone?.length ?? 0) > 0;
}
