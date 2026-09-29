import {
  KnowledgeInboxChoiceEnum,
  KnowledgeInboxKindEnum,
  KnowledgeReviewReasonEnum,
  KnowledgeTriageDecisionEnum,
  type KnowledgeInboxItem,
} from '@vantikhq/types';
import { describe, expect, it } from 'vitest';

import {
  doneLine,
  eventLine,
  inboxChoices,
  inboxReason,
  inboxSubline,
  inboxTitle,
  isToday,
} from './inbox';

function item(overrides: Partial<KnowledgeInboxItem>): KnowledgeInboxItem {
  return {
    id: 'item-1',
    kind: KnowledgeInboxKindEnum.FACT,
    subjectId: 'entry-1',
    raisedAt: '2026-09-28T10:00:00Z',
    raisedBy: 'triage',
    assigneeId: null,
    doneAt: null,
    doneById: null,
    resolution: null,
    entry: {
      id: 'entry-1',
      pageId: 'page-1',
      content: 'Redis holds only cache',
      scope: null,
      kind: 'FACT',
      status: 'PROPOSED',
      sourceUserId: 'agent-1',
      createdAt: '2026-09-28T10:00:00Z',
    } as KnowledgeInboxItem['entry'],
    pageId: 'page-1',
    pageTitle: 'Deployment',
    reasons: [],
    decision: null,
    proposal: null,
    gap: null,
    ...overrides,
  };
}

const names: Record<string, string> = { sam: 'Sam', chris: 'Chris' };
const nameOf = (userId: string | null) => (userId ? names[userId] : null);

describe('an inbox item as a question', () => {
  it('asks each kind the way a person answers it', () => {
    expect(inboxTitle(item({}))).toBe('Redis holds only cache');
    expect(inboxTitle(item({ kind: KnowledgeInboxKindEnum.RULE }))).toBe(
      'Is “Redis holds only cache” the rule?',
    );
    expect(
      inboxTitle(
        item({
          kind: KnowledgeInboxKindEnum.AUDIT,
          decision: {
            id: 'd1',
            decision: KnowledgeTriageDecisionEnum.AUTO_ACCEPT,
            policy: null,
          },
        }),
      ),
    ).toBe('Was it right to accept “Redis holds only cache”?');
    expect(
      inboxTitle(item({ kind: KnowledgeInboxKindEnum.REWRITE, entry: null })),
    ).toBe('Accept the rewrite of Deployment?');
    expect(
      inboxTitle(
        item({
          kind: KnowledgeInboxKindEnum.GAP,
          entry: null,
          gap: { query: 'how often does vantik cut a release', count: 3 },
        }),
      ),
    ).toBe('how often does vantik cut a release?');
  });

  it('says where it comes from under it', () => {
    expect(inboxSubline(item({}))).toBe('Deployment');
    expect(inboxSubline(item({ pageTitle: null, pageId: null }))).toBe(
      'Outside any page',
    );
    expect(
      inboxSubline(
        item({
          kind: KnowledgeInboxKindEnum.GAP,
          gap: { query: 'q', count: 3 },
        }),
      ),
    ).toBe('asked by 3 runs');
    expect(inboxSubline(item({ kind: KnowledgeInboxKindEnum.AUDIT }))).toBe(
      'settled by agents',
    );
  });

  it('names a contradiction of a confirmed fact as the board does', () => {
    expect(
      inboxReason(
        item({
          kind: KnowledgeInboxKindEnum.CONTRADICTION,
          reasons: [KnowledgeReviewReasonEnum.CONTRADICTS_VERIFIED],
        }),
      ),
    ).toBe('Contradicts a fact a person confirmed');
  });
});

describe('the answers an item takes', () => {
  it.each([
    [KnowledgeInboxKindEnum.CONTRADICTION, ['USE_NEW', 'KEEP_OLD']],
    [KnowledgeInboxKindEnum.RULE, ['USE', 'SET_ASIDE']],
    [KnowledgeInboxKindEnum.FACT, ['USE', 'SET_ASIDE']],
    [KnowledgeInboxKindEnum.AUDIT, ['AGREE', 'UNDO']],
    [KnowledgeInboxKindEnum.ARCHIVE, ['RETIRE', 'KEEP']],
    [KnowledgeInboxKindEnum.REWRITE, ['ACCEPT', 'DECLINE']],
    [KnowledgeInboxKindEnum.GAP, []],
  ])('a %s takes %j', (kind, expected) => {
    expect(inboxChoices(item({ kind })).map(({ choice }) => choice)).toEqual(
      expected,
    );
  });

  it('puts the answer triage expects first for an audit', () => {
    const [agree, undo] = inboxChoices(
      item({
        kind: KnowledgeInboxKindEnum.AUDIT,
        decision: {
          id: 'd1',
          decision: KnowledgeTriageDecisionEnum.AUTO_ACCEPT,
          policy: null,
        },
      }),
    );

    expect(agree).toEqual({
      choice: KnowledgeInboxChoiceEnum.AGREE,
      label: 'Right to use it',
    });
    expect(undo.label).toBe('Set it aside');
  });
});

describe('what the thread says', () => {
  it('says who decided a done item, and what', () => {
    expect(
      doneLine(
        item({ doneById: 'sam', resolution: 'kept the old fact' }),
        nameOf,
      ),
    ).toBe('Sam kept the old fact');
    expect(
      doneLine(item({ resolution: 'settled outside Needs you' }), nameOf),
    ).toBe('Settled outside Needs you');
  });

  it('says an assignment from the one who made it', () => {
    const event = {
      id: 'e1',
      createdAt: '2026-09-28T10:00:00Z',
      type: 'ASSIGNED',
      userId: 'chris',
      assigneeId: 'sam' as string | null,
      body: null as string | null,
    };

    expect(eventLine(event as never, nameOf)).toBe('assigned it to Sam');
    expect(eventLine({ ...event, assigneeId: 'chris' } as never, nameOf)).toBe(
      'took it',
    );
    expect(eventLine({ ...event, assigneeId: null } as never, nameOf)).toBe(
      'took everyone off it',
    );
  });

  it('knows today from yesterday', () => {
    const now = new Date(2026, 8, 28, 15);

    expect(isToday(new Date(2026, 8, 28, 1), now)).toBe(true);
    expect(isToday(new Date(2026, 8, 27, 23), now)).toBe(false);
    expect(isToday(null, now)).toBe(false);
  });
});
