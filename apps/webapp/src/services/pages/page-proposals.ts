import type { PageProposal } from '@vantikhq/types';

/**
 * Proposed consolidations of a page people write.
 *
 * The server makes every consolidation a proposal, whoever asks: a page
 * people write changes only when a person accepts the change. A person
 * consolidating from the page is that person, so the webapp proposes and
 * accepts in one step; an agent's proposal waits in the review queue.
 */

export interface PageProposalRef {
  pageId: string;
  proposalId: string;
}

export type ProposalAnswer = 'accept' | 'decline';

export function proposalAnswerUrl(
  { pageId, proposalId }: PageProposalRef,
  answer: ProposalAnswer,
): string {
  return `/api/v1/pages/${pageId}/proposals/${proposalId}/${answer}`;
}

/**
 * Proposes, then accepts what was proposed. If accepting fails (the page
 * changed meanwhile, or a fact moved on), the proposal stays open in the
 * review queue and the error is the server's reason.
 */
export async function proposeAndAccept<T>(
  propose: () => Promise<PageProposal>,
  accept: (ref: PageProposalRef) => Promise<T>,
): Promise<T> {
  const proposal = await propose();

  return accept({ pageId: proposal.pageId, proposalId: proposal.id });
}

/** What a proposal asks, in one line: "Fold 3 facts into Runbook". */
export function pageProposalSummary(proposal: PageProposal): string {
  const count = proposal.entryIds.length;

  return (
    `Fold ${count} ${count === 1 ? 'fact' : 'facts'} into ` +
    `${proposal.pageTitle || 'Untitled page'}`
  );
}
