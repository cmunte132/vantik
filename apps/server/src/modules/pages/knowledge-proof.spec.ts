/**
 * The trust tier and proof every served item of knowledge carries.
 */
import { KnowledgeTrustEnum, PageEntryStatusEnum } from '@vantikhq/types';

import {
  describeProof,
  entryProof,
  entryTrust,
  pageBodyProof,
  ProofCitationRow,
} from './knowledge-proof';

function citation(overrides: Partial<ProofCitationRow> = {}): ProofCitationRow {
  return {
    kind: 'CODE',
    path: 'src/a.ts',
    commitSha: 'abcdef1234567',
    startLine: 40,
    endLine: 52,
    targetLabel: null,
    checkedAt: new Date('2026-09-20T10:00:00Z'),
    checkedSha: '9f8e7d6c5b4a39f8e7d6c5b4a3',
    checkResult: 'HOLDS',
    judgment: null,
    judgeModel: null,
    moduleRepo: { fullName: 'acme/api' },
    ...overrides,
  };
}

const STANDING = PageEntryStatusEnum.STANDING;

describe('trust', () => {
  it('[KG-2.7] is HUMAN_VERIFIED once a person has confirmed the entry', () => {
    expect(
      entryTrust({ status: STANDING, verifiedAt: new Date(), citations: [] }),
    ).toBe(KnowledgeTrustEnum.HUMAN_VERIFIED);
  });

  it('[KG-2.7] is GROUNDED when accepted without a person and every citation holds or moved', () => {
    expect(
      entryTrust({
        status: STANDING,
        verifiedAt: null,
        citations: [{ checkResult: 'HOLDS' }, { checkResult: 'MOVED' }],
      }),
    ).toBe(KnowledgeTrustEnum.GROUNDED);
  });

  it('[KG-2.7] is UNGROUNDED with no citations, one that failed or went unread, or before acceptance', () => {
    const ungrounded = [
      { status: STANDING, citations: [] },
      {
        status: STANDING,
        citations: [{ checkResult: 'HOLDS' }, { checkResult: 'MISSING' }],
      },
      // A judge thinking changed code still agrees is an opinion, not a check.
      { status: STANDING, citations: [{ checkResult: 'CHANGED' }] },
      { status: STANDING, citations: [{ checkResult: 'UNKNOWN' }] },
      {
        status: PageEntryStatusEnum.PROPOSED,
        citations: [{ checkResult: 'HOLDS' }],
      },
    ];

    for (const entry of ungrounded) {
      expect(entryTrust({ ...entry, verifiedAt: null })).toBe(
        KnowledgeTrustEnum.UNGROUNDED,
      );
    }
  });
});

describe('proof', () => {
  it('[KG-2.8] lists each citation with its last check, and the latest check of all', () => {
    const later = new Date('2026-09-25T08:00:00Z');

    expect(
      entryProof({
        status: STANDING,
        verifiedAt: null,
        citations: [
          citation(),
          citation({
            kind: 'ISSUE',
            path: null,
            commitSha: null,
            startLine: null,
            endLine: null,
            targetLabel: 'ENG-42',
            checkedAt: later,
            checkedSha: null,
            moduleRepo: null,
          }),
          citation({
            startLine: 7,
            endLine: 7,
            checkResult: 'CHANGED',
            judgment: 'CONTRADICTED',
            judgeModel: 'vendor/smart',
          }),
        ],
      }),
    ).toEqual({
      trust: KnowledgeTrustEnum.UNGROUNDED,
      citations: [
        {
          kind: 'CODE',
          repo: 'acme/api',
          path: 'src/a.ts',
          commitSha: 'abcdef1234567',
          lines: '40-52',
          result: 'HOLDS',
          checkedAt: '2026-09-20T10:00:00.000Z',
          checkedSha: '9f8e7d6c5b4a39f8e7d6c5b4a3',
        },
        {
          kind: 'ISSUE',
          target: 'ENG-42',
          result: 'HOLDS',
          checkedAt: later.toISOString(),
          checkedSha: null,
        },
        {
          kind: 'CODE',
          repo: 'acme/api',
          path: 'src/a.ts',
          commitSha: 'abcdef1234567',
          lines: '7',
          result: 'CHANGED',
          checkedAt: '2026-09-20T10:00:00.000Z',
          checkedSha: '9f8e7d6c5b4a39f8e7d6c5b4a3',
          judgment: 'CONTRADICTED',
          judgeModel: 'vendor/smart',
        },
      ],
      lastCheckedAt: later.toISOString(),
      lastCheckedSha: null,
    });
  });

  it('[KG-2.8] gives a page body no tier and nothing to cite', () => {
    expect(pageBodyProof()).toEqual({
      trust: null,
      citations: [],
      lastCheckedAt: null,
      lastCheckedSha: null,
    });
  });

  it('[KG-2.8] reads as one line of prose for a prompt', () => {
    expect(
      describeProof(
        entryProof({
          status: STANDING,
          verifiedAt: null,
          citations: [
            citation(),
            citation({ kind: 'PULL_REQUEST', targetLabel: 'https://x/pull/5' }),
          ],
        }),
      ),
    ).toBe(
      'grounded · cites acme/api:src/a.ts:40-52 (holds), pull request https://x/pull/5 (holds) · checked 2026-09-20 at 9f8e7d6c5b4a',
    );
    expect(
      describeProof(entryProof({ status: STANDING, verifiedAt: null })),
    ).toBe('ungrounded · cites nothing');
    expect(describeProof(pageBodyProof())).toBe('page narrative');
  });
});
