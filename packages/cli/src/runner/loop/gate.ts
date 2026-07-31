import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { git } from '../git';
import type { FrozenTest, SuiteResult } from './phases';

const exec = promisify(execFile);

/**
 * The red-on-base gate.
 *
 * The cheapest and most valuable check in the whole loop: run the generated
 * tests against the base commit and require every one of them to fail. A test
 * that passes before the implementation exists is not testing the change.
 *
 * This matters because the test writer is the loop's weakest link. LLM test
 * generation measures around 53% mutation score, weak assertions
 * (`assertNotNull` where a value check belongs) are the characteristic defect,
 * and a 2026 study found the volume of tests an agent wrote during autonomous
 * bug-fixing correlated only weakly with whether it fixed anything — much of
 * what agents called tests were closer to print statements.
 *
 * Red-then-green is machine-checkable and costs no tokens, which is why it is
 * a hard gate rather than a heuristic. Mutation-guided generation is the next
 * lever if we ever want to spend more.
 */
export interface GateResult {
  /** Tests that correctly failed on base, and so are worth keeping. */
  kept: FrozenTest[];
  /** Tests that passed before the change existed. Rejected. */
  rejected: FrozenTest[];
}

export async function requireRedOnBase(
  workdir: string,
  baseCommit: string,
  tests: FrozenTest[],
  testCommand: string,
): Promise<GateResult> {
  if (tests.length === 0) {
    return { kept: [], rejected: [] };
  }

  // A detached worktree at the base commit, so the check never disturbs the
  // checkout the implementation happens in.
  const probe = join(workdir, '..', 'base-probe');

  await git(workdir, ['worktree', 'add', '--detach', '--quiet', probe, baseCommit]);

  try {
    const kept: FrozenTest[] = [];
    const rejected: FrozenTest[] = [];

    for (const test of tests) {
      const target = join(probe, test.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, test.contents, 'utf8');

      const failed = await failsAt(probe, testCommand, test.path);

      // Failing here is the pass condition, which reads backwards and is
      // exactly the point: the test must prove it can tell the difference.
      (failed ? kept : rejected).push(test);

      await rm(target, { force: true });
    }

    return { kept, rejected };
  } finally {
    await git(workdir, ['worktree', 'remove', '--force', probe], {
      allowFailure: true,
    });
  }
}

/** Whether the command fails with this test present. */
async function failsAt(
  cwd: string,
  testCommand: string,
  path: string,
): Promise<boolean> {
  try {
    await exec(`${testCommand} ${path}`, {
      cwd,
      shell: true,
      timeout: 5 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return false;
  } catch {
    // A non-zero exit is what we want. It does not distinguish "the assertion
    // failed" from "the file would not even load", but both mean the test
    // cannot pass on base, which is the property being gated on.
    return true;
  }
}

/**
 * Restores frozen tests from their pristine copies before scoring.
 *
 * Scoring against whatever is on disk would grade the implementation against
 * tests the implementation may have edited. Re-applying from the frozen copy
 * makes that irrelevant: tampering is still *detected* and flagged, but it
 * cannot affect the score.
 */
export async function restorePristine(
  workdir: string,
  tests: FrozenTest[],
): Promise<void> {
  for (const test of tests) {
    const target = join(workdir, test.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, test.contents, 'utf8');
  }
}

/** Runs one suite and reports how much of it passed. */
export async function runSuite(
  workdir: string,
  testCommand: string,
  tests: FrozenTest[],
): Promise<SuiteResult> {
  let passed = 0;

  for (const test of tests) {
    try {
      await exec(`${testCommand} ${test.path}`, {
        cwd: workdir,
        shell: true,
        timeout: 5 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      });
      passed += 1;
    } catch {
      // Counted as a failure and nothing more; which test failed is the
      // implementer's problem, and the rate is what the loop reasons about.
    }
  }

  return { passed, total: tests.length };
}
