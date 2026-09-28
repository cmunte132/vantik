import { PageProposalStateEnum, type PageProposal } from '@vantikhq/types';
import { describe, expect, it, vi } from 'vitest';

import {
  pageProposalSummary,
  proposalAnswerUrl,
  proposeAndAccept,
} from './page-proposals';

/**
 * Consolidating from the page: the server proposes, and the person asking
 * accepts their own proposal. Nothing is accepted that was not proposed.
 */

function proposal(overrides: Partial<PageProposal> = {}): PageProposal {
  return {
    id: 'proposal-1',
    createdAt: '2026-09-28T10:00:00.000Z',
    pageId: 'page-1',
    pageTitle: 'Runbook',
    bodyMarkdown: '## Runbook\n\nRestart the worker.',
    entryIds: ['entry-1', 'entry-2'],
    proposedById: 'user-1',
    state: PageProposalStateEnum.OPEN,
    decidedById: null,
    decidedAt: null,
    ...overrides,
  };
}

describe('a consolidation from the page', () => {
  it('[KG-7.4] accepts the proposal it just made, and only that one', async () => {
    const propose = vi.fn(async () => proposal());
    const accept = vi.fn(async () => ({ id: 'page-1' }));

    await expect(proposeAndAccept(propose, accept)).resolves.toEqual({
      id: 'page-1',
    });
    expect(accept).toHaveBeenCalledWith({
      pageId: 'page-1',
      proposalId: 'proposal-1',
    });
  });

  it('[KG-7.4] accepts nothing when the proposal was refused', async () => {
    const propose = vi.fn(async (): Promise<PageProposal> => {
      throw new Error('No standing entries on this page to consolidate.');
    });
    const accept = vi.fn();

    await expect(proposeAndAccept(propose, accept)).rejects.toThrow(
      'No standing entries',
    );
    expect(accept).not.toHaveBeenCalled();
  });

  it('[KG-7.4] answers a proposal on its page', () => {
    const ref = { pageId: 'page-1', proposalId: 'proposal-1' };

    expect(proposalAnswerUrl(ref, 'accept')).toBe(
      '/api/v1/pages/page-1/proposals/proposal-1/accept',
    );
    expect(proposalAnswerUrl(ref, 'decline')).toBe(
      '/api/v1/pages/page-1/proposals/proposal-1/decline',
    );
  });

  it('[KG-7.4] says what a proposal asks', () => {
    expect(pageProposalSummary(proposal())).toBe('Fold 2 facts into Runbook');
    expect(
      pageProposalSummary(proposal({ entryIds: ['entry-1'], pageTitle: '' })),
    ).toBe('Fold 1 fact into Untitled page');
  });
});
