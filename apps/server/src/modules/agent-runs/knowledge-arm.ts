import type { KnowledgeArm } from '@prisma/client';

import { createHash } from 'node:crypto';

/**
 * Which runs are handed the workspace's knowledge, and which are held out.
 *
 * Knowledge in a prompt costs tokens and can mislead, so whether it helps is
 * a question to measure rather than assume. A share of runs is held out: they
 * get an empty knowledge section, and the two arms are compared on what
 * happened to their work.
 *
 * The arm is a hash of the run's id rather than a coin toss, so it is the
 * same whenever it is worked out, and depends on nothing about the issue or
 * the person delegating — either would let the arms differ in something other
 * than the knowledge. The share held out is the workspace's `holdoutRate`
 * (`knowledge-settings.ts`).
 */

/**
 * The arm of the run with this id: the first 32 bits of its sha256, read as a
 * fraction of the range, fall below the holdout rate or they do not.
 */
export function knowledgeArmFor(
  runId: string,
  holdoutRate: number,
): KnowledgeArm {
  const bucket =
    parseInt(createHash('sha256').update(runId).digest('hex').slice(0, 8), 16) /
    0x1_0000_0000;

  return bucket < holdoutRate ? 'HOLDOUT' : 'TREATMENT';
}
