import {
  type LinkedIssue,
  type Transition,
  billingKey,
  issueAt,
  resolveTaskRef,
  transitionOf,
} from './session-attribution';

const at = (ms: number) =>
  new Date(Date.parse('2026-10-09T10:00:00.000Z') + ms);

const links: LinkedIssue[] = [
  { id: 'issue-a', key: 'ENG-1', createdAt: at(0) },
  { id: 'issue-b', key: 'ENG-2', createdAt: at(5000) },
];

describe('resolveTaskRef', () => {
  it('resolves a linked issue by key, in any case, or by id', () => {
    expect(resolveTaskRef(' eng-2 ', links)).toBe('issue-b');
    expect(resolveTaskRef('issue-a', links)).toBe('issue-a');
  });

  it('names no issue for a task that the session is not linked to', () => {
    expect(resolveTaskRef('ENG-99', links)).toBeNull();
  });
});

describe('issueAt', () => {
  it('belongs to the latest link created by the time of the call', () => {
    expect(issueAt(at(2000), [], links)).toBe('issue-a');
    expect(issueAt(at(6000), [], links)).toBe('issue-b');
  });

  it('belongs to no issue before the first link', () => {
    const later = [{ id: 'issue-b', key: 'ENG-2', createdAt: at(5000) }];

    expect(issueAt(at(1000), [], later)).toBeNull();
  });

  it('follows the latest transition before the call, even when a later link exists', () => {
    const transitions = [
      { at: at(1000), issueId: 'issue-b' },
      { at: at(3000), issueId: 'issue-a' },
    ];

    expect(issueAt(at(2000), transitions, links)).toBe('issue-b');
    expect(issueAt(at(4000), transitions, links)).toBe('issue-a');
  });

  it('keeps a call in the same moment as its pickup on the earlier issue', () => {
    const transitions = [{ at: at(1000), issueId: 'issue-b' }];

    expect(issueAt(at(1000), transitions, links)).toBe('issue-a');
  });

  it('gives no issue to work after a pickup that named no linked issue', () => {
    const transitions: Transition[] = [{ at: at(1000), issueId: null }];

    expect(issueAt(at(2000), transitions, links)).toBeNull();
  });
});

describe('transitionOf', () => {
  it('moves the work on a linked write, and on a pickup of a linked task', () => {
    expect(transitionOf(at(1000), 'write', 'ENG-2', links)).toEqual({
      at: at(1000),
      issueId: 'issue-b',
    });
    expect(transitionOf(at(1000), 'pickup', 'ENG-1', links)).toEqual({
      at: at(1000),
      issueId: 'issue-a',
    });
  });

  it('does not move the work on a write to an unlinked task, but does on a pickup of one', () => {
    expect(transitionOf(at(1000), 'write', 'ENG-9', links)).toBeNull();
    expect(transitionOf(at(1000), 'pickup', 'ENG-9', links)).toEqual({
      at: at(1000),
      issueId: null,
    });
  });
});

describe('billingKey', () => {
  it('keeps the billing mode and the cost basis apart', () => {
    expect(billingKey('subscription', 'list')).toBe('subscription/list');
    expect(billingKey('metered', 'harness_estimate')).toBe(
      'metered/harness_estimate',
    );
  });
});
