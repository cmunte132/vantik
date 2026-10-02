import type { PageEntryCheck } from '@vantikhq/types';

/**
 * What each acceptance check of a triage decision said, from its recorded
 * outputs, in the shape a person reads: a verdict and the check's own reason.
 */
export function checksOf(outputs: unknown): PageEntryCheck[] {
  const accept = (outputs as { accept?: unknown } | null)?.accept;

  if (!Array.isArray(accept)) {
    return [];
  }

  return accept.map((judgment: Record<string, unknown>) => ({
    verdict: !judgment.readable
      ? null
      : judgment.accept
        ? 'accept'
        : judgment.contradicted
          ? 'contradicted'
          : 'escalate',
    reason: typeof judgment.reason === 'string' ? judgment.reason : null,
  }));
}
