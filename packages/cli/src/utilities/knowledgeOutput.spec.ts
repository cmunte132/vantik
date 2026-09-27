import type {
  KnowledgeEntry,
  KnowledgeHit,
  KnowledgeProof,
} from '@vantikhq/agent-core';

import {
  renderEntries,
  renderHits,
  renderProof,
  renderRemember,
} from './knowledgeOutput';

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

  function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
    return {
      id: '1a2b3c4d-0000-0000-0000-000000000000',
      content: 'Redis holds only cache here.',
      scope: 'apps/server',
      status: 'STANDING',
      sourceUserId: null,
      sourceSession: null,
      verified: false,
      retrievalCount: 2,
      supersedesId: null,
      pageId: 'page-1',
      createdAt: '2026-09-20T10:00:00.000Z',
      ...proof,
      ...overrides,
    };
  }

  it('[KG-2.8] lists entries with their trust, and beneath the table what each cites and when it was checked', () => {
    const text = renderEntries([
      entry(),
      entry({
        id: '5e6f7a8b-0000-0000-0000-000000000000',
        trust: 'UNGROUNDED',
        citations: [],
        lastCheckedAt: null,
        lastCheckedSha: null,
      }),
    ]);

    expect(text).toContain('grounded');
    expect(text).toContain(
      '1a2b3c4d  cites src/cache.ts:12-30 (moved), pull request https://github.com/acme/api/pull/5 (holds) · checked 2026-09-20 at 9f8e7d6c5b4a',
    );
    expect(text).not.toMatch(/5e6f7a8b {2}cites/);
  });

  it('[KG-2.8] tells the writer what its citations came to once the fact is written', () => {
    expect(
      renderRemember({
        status: 'written',
        entry: entry({
          trust: 'UNGROUNDED',
          citations: [
            {
              kind: 'CODE',
              repo: 'acme/api',
              path: 'src/cache.ts',
              lines: '12-30',
              commitSha: 'abcdef1',
              result: 'UNKNOWN',
              checkedAt: null,
              checkedSha: null,
            },
          ],
        }),
      }),
    ).toBe(
      'Remembered 1a2b3c4d-0000-0000-0000-000000000000\ncites src/cache.ts:12-30 (unknown) · checked 2026-09-20 at 9f8e7d6c5b4a',
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
