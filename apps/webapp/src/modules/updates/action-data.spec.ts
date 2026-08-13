import { describe, expect, it } from 'vitest';

import { NotificationTypeEnum, type NotificationType } from 'common/types';

import { getActionData, getNotificationText } from './action-data';

function notification(actionData: string | null): NotificationType {
  return {
    id: 'n1',
    createdAt: '2026-08-01T03:40:16.000Z',
    updatedAt: '2026-08-01T03:40:16.000Z',
    type: NotificationTypeEnum.IssueNewComment,
    userId: 'u1',
    issueId: 'i1',
    actionData,
    workspaceId: 'w1',
  } as unknown as NotificationType;
}

describe('getActionData', () => {
  it('reads the payload the server wrote', () => {
    expect(getActionData(notification('{"issueCommentId":"c1"}'))).toEqual({
      issueCommentId: 'c1',
    });
  });

  it('reads every shape the server writes', () => {
    expect(getActionData(notification('{"stateId":"s1"}')).stateId).toBe('s1');
    expect(getActionData(notification('{"priorityId":"1"}')).priorityId).toBe(
      '1',
    );
    expect(getActionData(notification('{"userId":"u2"}')).userId).toBe('u2');
    expect(
      getActionData(notification('{"issueRelationId":"r1"}')).issueRelationId,
    ).toBe('r1');
  });

  // A notification with no readable payload still says that something
  // happened, so the reader must get an object it can ask questions of.
  it('gives an empty payload rather than throwing on bad JSON', () => {
    expect(getActionData(notification('{not json'))).toEqual({});
  });

  it('gives an empty payload when there is none', () => {
    expect(getActionData(notification(null))).toEqual({});
  });

  // `JSON.stringify(undefined)` is `undefined`, and a client that stored that
  // before the write was hardened holds the string 'undefined'.
  it('gives an empty payload for a non-object payload', () => {
    expect(getActionData(notification('undefined'))).toEqual({});
    expect(getActionData(notification('"a string"'))).toEqual({});
    expect(getActionData(notification('null'))).toEqual({});
  });
});

describe('getNotificationText', () => {
  it('names what happened and who did it', () => {
    expect(
      getNotificationText('Ada', NotificationTypeEnum.IssueNewComment),
    ).toBe('New comment from Ada');
    expect(getNotificationText('Ada', NotificationTypeEnum.IssueAssigned)).toBe(
      'Assigned by Ada',
    );
  });

  it('capitalises the priority sentence like every other one', () => {
    expect(
      getNotificationText('Ada', NotificationTypeEnum.IssuePriorityChanged),
    ).toBe('Priority changed by Ada');
  });
});
