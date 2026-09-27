import {
  KnowledgeReviewReasonEnum,
  KnowledgeTriageDecisionEnum,
  type KnowledgeReviewItem,
  type KnowledgeReviewQueue,
} from '@vantikhq/types';
import { describe, expect, it } from 'vitest';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import {
  auditPrompt,
  REASON_LABELS,
  reasonFacets,
  reviewRows,
  withReason,
} from './review-reasons';

/**
 * The queue's rows. What it must never do is lose a waiting fact: with
 * triage off, or before the server answers, it is the inbox it always was.
 */

function entry(overrides: Partial<PageEntryType> = {}): PageEntryType {
  return {
    id: 'entry-1',
    pageId: 'page-1',
    content: 'We deploy with podman.',
    scope: null,
    kind: null,
    status: PageEntryStatus.PROPOSED,
    sourceUserId: 'user-1',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    retrievalCount: 0,
    ...overrides,
  } as PageEntryType;
}

function item(
  overrides: Partial<KnowledgeReviewItem> & { entryId?: string } = {},
): KnowledgeReviewItem {
  const { entryId = 'entry-1', ...rest } = overrides;

  return {
    entry: {
      id: entryId,
      pageId: 'page-1',
      content: 'We deploy with podman.',
      scope: null,
      kind: null,
      status: PageEntryStatus.PROPOSED,
      sourceUserId: 'user-1',
      createdAt: '2026-09-20T10:00:00.000Z',
    },
    decisionId: `decision-${entryId}`,
    decision: KnowledgeTriageDecisionEnum.ESCALATE,
    mode: 'on',
    reasons: [],
    audit: false,
    policy: null,
    backedOffFrom: null,
    ...rest,
  } as KnowledgeReviewItem;
}

function queue(
  items: KnowledgeReviewItem[],
  autoTriage: KnowledgeReviewQueue['autoTriage'] = 'on',
): KnowledgeReviewQueue {
  return { autoTriage, items, reasons: [] };
}

const nowhere = (): PageEntryType | undefined => undefined;

describe('the review queue', () => {
  it('[KG-5.1] labels each waiting fact with why triage held it back', () => {
    const rows = reviewRows(
      [entry({ id: 'a' }), entry({ id: 'b' })],
      queue([
        item({
          entryId: 'a',
          reasons: [
            KnowledgeReviewReasonEnum.UNGROUNDED,
            KnowledgeReviewReasonEnum.BROAD_SCOPE,
          ],
        }),
        item({ entryId: 'b', reasons: [] }),
      ]),
      nowhere,
    );

    expect(rows.map((row) => [row.entry.id, row.reasons])).toEqual([
      ['a', ['UNGROUNDED', 'BROAD_SCOPE']],
      ['b', []],
    ]);
    expect(rows.every((row) => row.audit === null)).toBe(true);
  });

  it('[KG-5.1] adds the audits after the waiting facts, each naming the decision it checks', () => {
    const inUse = entry({ id: 'kept', status: PageEntryStatus.STANDING });
    const rows = reviewRows(
      [entry({ id: 'a' })],
      queue([
        item({ entryId: 'a' }),
        item({
          entryId: 'kept',
          decisionId: 'decision-9',
          decision: KnowledgeTriageDecisionEnum.AUTO_ACCEPT,
          audit: true,
          reasons: [KnowledgeReviewReasonEnum.AUDIT],
        }),
      ]),
      (entryId) => (entryId === 'kept' ? inUse : undefined),
    );

    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      entry: inUse,
      reasons: ['AUDIT'],
      audit: {
        decisionId: 'decision-9',
        decision: 'AUTO_ACCEPT',
        policy: null,
      },
    });
  });

  it('[KG-5.1] shows an audited fact the store does not hold as the server sent it', () => {
    const [row] = reviewRows(
      [],
      queue([
        item({
          entryId: 'elsewhere',
          decision: KnowledgeTriageDecisionEnum.REJECT,
          policy: 'ONE_FACT',
          audit: true,
          reasons: [KnowledgeReviewReasonEnum.AUDIT],
        }),
      ]),
      nowhere,
    );

    expect(row.entry).toMatchObject({
      id: 'elsewhere',
      pageId: 'page-1',
      content: 'We deploy with podman.',
    });
    expect(row.audit?.policy).toBe('ONE_FACT');
  });

  it.each([
    [
      'triage is off',
      // Whatever it holds, a queue with triage off adds nothing.
      queue(
        [
          item({ entryId: 'a', reasons: [KnowledgeReviewReasonEnum.NO_LLM] }),
          item({
            entryId: 'kept',
            decision: KnowledgeTriageDecisionEnum.AUTO_ACCEPT,
            audit: true,
            reasons: [KnowledgeReviewReasonEnum.AUDIT],
          }),
        ],
        'off',
      ),
    ],
    ['the server has not answered', undefined],
  ])('[KG-5.1] is exactly the facts waiting when %s', (_, review) => {
    const waiting = [entry({ id: 'a' }), entry({ id: 'b' })];

    expect(reviewRows(waiting, review, nowhere)).toEqual([
      { entry: waiting[0], reasons: [], audit: null },
      { entry: waiting[1], reasons: [], audit: null },
    ]);
  });

  it('[KG-5.1] never drops a waiting fact the server did not mention', () => {
    const rows = reviewRows([entry({ id: 'new' })], queue([]), nowhere);

    expect(rows.map((row) => row.entry.id)).toEqual(['new']);
  });

  it('[KG-5.1] filters by reason and counts each, the most common first', () => {
    const rows = reviewRows(
      [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })],
      queue([
        item({
          entryId: 'a',
          reasons: [KnowledgeReviewReasonEnum.CONTRADICTS_VERIFIED],
        }),
        item({ entryId: 'b', reasons: [KnowledgeReviewReasonEnum.UNGROUNDED] }),
        item({
          entryId: 'c',
          reasons: [
            KnowledgeReviewReasonEnum.UNGROUNDED,
            KnowledgeReviewReasonEnum.BROAD_SCOPE,
          ],
        }),
      ]),
      nowhere,
    );

    expect(reasonFacets(rows)).toEqual([
      { reason: 'UNGROUNDED', label: 'Cites nothing', count: 2 },
      // A tie goes by label.
      { reason: 'BROAD_SCOPE', label: 'Applies widely', count: 1 },
      {
        reason: 'CONTRADICTS_VERIFIED',
        label: 'Contradicts a confirmed fact',
        count: 1,
      },
    ]);
    expect(
      withReason(rows, KnowledgeReviewReasonEnum.UNGROUNDED).map(
        (row) => row.entry.id,
      ),
    ).toEqual(['b', 'c']);
    expect(withReason(rows, null)).toBe(rows);
  });

  it('[KG-5.1] has a label for every reason', () => {
    for (const reason of Object.values(KnowledgeReviewReasonEnum)) {
      expect(REASON_LABELS[reason]).toMatch(/\w/);
    }
  });

  it('[KG-5.2] asks each audit about what triage did, worded as each answer does', () => {
    const accepted = auditPrompt({
      decisionId: 'd',
      decision: KnowledgeTriageDecisionEnum.AUTO_ACCEPT,
      policy: null,
    });
    const folded = auditPrompt({
      decisionId: 'd',
      decision: KnowledgeTriageDecisionEnum.CORROBORATE,
      policy: null,
    });
    const refused = auditPrompt({
      decisionId: 'd',
      decision: KnowledgeTriageDecisionEnum.REJECT,
      policy: 'ONE_FACT',
    });

    expect([accepted.agree, accepted.disagree]).toEqual([
      'Right to use it',
      'Set it aside',
    ]);
    expect(folded.question).toMatch(/repeat/);
    expect(folded.disagree).toBe('Not a repeat: use it');
    expect(refused.question).toMatch(/several claims/);
    expect(refused.disagree).toBe('Use it');
  });
});
