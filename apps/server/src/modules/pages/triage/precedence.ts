import { KnowledgeTrustEnum } from '@vantikhq/types';

/**
 * Which of two contradicting entries stands.
 *
 * Decided in code, in a fixed order, and never by a model: a person's
 * verification beats a grounded entry, a grounded entry beats an ungrounded
 * one, and within a tier the newer entry wins, because the later of two
 * claims of the same standing is the likelier to describe the system as it
 * is now. A model only reports that two entries contradict; what follows from
 * it does not depend on how the model phrased its answer.
 */

const RANK: Record<KnowledgeTrustEnum, number> = {
  [KnowledgeTrustEnum.HUMAN_VERIFIED]: 2,
  [KnowledgeTrustEnum.GROUNDED]: 1,
  [KnowledgeTrustEnum.UNGROUNDED]: 0,
};

export interface Contender {
  id: string;
  trust: KnowledgeTrustEnum;
  createdAt: Date;
}

/** The entry precedence prefers. Ties on both counts go to the first. */
export function preferred<T extends Contender>(a: T, b: T): T {
  if (RANK[a.trust] !== RANK[b.trust]) {
    return RANK[a.trust] > RANK[b.trust] ? a : b;
  }

  return b.createdAt.getTime() > a.createdAt.getTime() ? b : a;
}
