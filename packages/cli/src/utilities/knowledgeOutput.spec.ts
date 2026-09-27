import type { KnowledgeHit, KnowledgeProof } from '@vantikhq/agent-core';

import { renderHits, renderProof, renderRemember } from './knowledgeOutput';

// chalk is ESM-only; colour is not what is being tested.
jest.mock('chalk', () => ({
  __esModule: true,
  default: {
    hex: () => (text: string) => text,
    yellow: (text: string) => text,
  },
}));

const proof: KnowledgeProof = {
  trust: 'GROUNDED',
  citations: [
    {
      kind: 'CODE',
      repo: 'acme/api',
      path: 'src/cache.ts',
      lines: '12-30',
      commitSha: 'abcdef1',
      result: 'MOVED',
      checkedAt: '2026-09-20T10:00:00.000Z',
      checkedSha: '9f8e7d6c5b4a3210',
    },
    {
      kind: 'PULL_REQUEST',
      target: 'https://github.com/acme/api/pull/5',
      result: 'HOLDS',
      checkedAt: '2026-09-19T10:00:00.000Z',
      checkedSha: null,
    },
  ],
  lastCheckedAt: '2026-09-20T10:00:00.000Z',
  lastCheckedSha: '9f8e7d6c5b4a3210',
};

describe('knowledge as a terminal shows it', () => {
  it('[KG-2.8] shows each hit with its trust tier, citations and last check', () => {
    const hit: KnowledgeHit = {
      kind: 'entry',
      entryKind: 'DECISION',
      page: { id: 'page-1', title: 'Server' },
      entryId: 'entry-1',
      content: 'Redis holds only cache here.',
      scope: 'apps/server',
      verified: false,
      retrievalCount: 2,
      ...proof,
    };

    const text = renderHits([hit]);

    expect(text).toContain('Server fact · apps/server · grounded');
    expect(text).toContain(
      'cites src/cache.ts:12-30 (moved), pull request https://github.com/acme/api/pull/5 (holds) · checked 2026-09-20 at 9f8e7d6c5b4a',
    );
  });

  it('[KG-2.8] says nothing about citations an item does not have', () => {
    expect(renderProof({ ...proof, citations: [] })).toBe('');
  });

  it('[KG-2.1] shows a refused citation as the reason nothing was written', () => {
    expect(
      renderRemember({
        status: 'citation-failed',
        citation: 1,
        message:
          'Nothing was written: citation 1 (src/a.ts:99): no such lines.',
      }),
    ).toBe('Nothing was written: citation 1 (src/a.ts:99): no such lines.');
  });
});
