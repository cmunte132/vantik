import {
  ActionEventPayload,
  ActionTypesEnum,
  NotificationActionType,
  NotificationEventFrom,
  sanitizeNotificationPreferences,
  wantsNotification,
} from '@vantikhq/types';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { UpdateUserBody } from 'modules/users/users.interface';

import { emailHandler } from './delivery/handlers/email-handler';
import { vantikHandler } from './delivery/handlers/vantik-handler';

const sendMail = jest.fn();
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail }) },
}));
jest.mock('common/smtp', () => ({
  smtpConfigured: () => true,
  smtpFrom: () => 'vantik@example.com',
  smtpTransportOptions: () => ({}),
}));

/**
 * Per-person choice of which notifications arrive, and where (ENG-182).
 *
 * The default matters as much as the switch: nobody who never opened the page
 * may lose a notification they get today.
 */
describe('wantsNotification', () => {
  it.each([undefined, null, {}, 'garbage', { comments: 'off' }])(
    'is on when nothing usable is stored (%p)',
    (stored) => {
      expect(
        wantsNotification(
          stored,
          NotificationActionType.IssueNewComment,
          'email',
        ),
      ).toBe(true);
    },
  );

  it('turns off only the channel and category asked for', () => {
    const stored = { comments: { email: false } };
    const comment = NotificationActionType.IssueNewComment;

    expect(wantsNotification(stored, comment, 'email')).toBe(false);
    expect(wantsNotification(stored, comment, 'inApp')).toBe(true);
    expect(
      wantsNotification(stored, NotificationActionType.IssueAssigned, 'email'),
    ).toBe(true);
  });

  it('treats being unassigned as part of assignments', () => {
    expect(
      wantsNotification(
        { assignments: { inApp: false } },
        NotificationActionType.IssueUnAssigned,
        'inApp',
      ),
    ).toBe(false);
  });

  it('keeps only known categories, channels and booleans', () => {
    expect(
      sanitizeNotificationPreferences({
        comments: { email: false, inApp: 'yes', sms: false },
        mentions: { email: false },
      }),
    ).toEqual({ comments: { email: false } });
  });
});

describe('UpdateUserBody.notificationPreferences', () => {
  const errorsFor = (notificationPreferences: unknown) =>
    validateSync(plainToInstance(UpdateUserBody, { notificationPreferences }));

  it('accepts a partial update', () => {
    expect(errorsFor({ comments: { email: false } })).toHaveLength(0);
  });

  it.each([
    { mentions: { email: false } },
    { comments: { sms: false } },
    { comments: { email: 'false' } },
    { comments: true },
    [],
  ])('rejects %p', (value) => {
    expect(errorsFor(value)).not.toHaveLength(0);
  });
});

const ACTOR = 'actor';

function commentPayload(): ActionEventPayload {
  return {
    event: ActionTypesEnum.ON_CREATE,
    notificationType: NotificationEventFrom.NewComment,
    notificationData: {
      userId: ACTOR,
      workspaceId: 'ws',
      issueId: 'issue-1',
      issueCommentId: 'comment-1',
      subscriberIds: [ACTOR, 'wants-all', 'no-email', 'no-inbox'],
    },
  } as unknown as ActionEventPayload;
}

const USERS = [
  {
    id: ACTOR,
    email: 'actor@x',
    fullname: 'Actor',
    notificationPreferences: {},
  },
  {
    id: 'wants-all',
    email: 'all@x',
    fullname: 'All',
    notificationPreferences: {},
  },
  {
    id: 'no-email',
    email: 'no-email@x',
    fullname: 'No Email',
    notificationPreferences: { comments: { email: false } },
  },
  {
    id: 'no-inbox',
    email: 'no-inbox@x',
    fullname: 'No Inbox',
    notificationPreferences: { comments: { inApp: false } },
  },
];

function fakePrisma() {
  const issue = {
    id: 'issue-1',
    title: 'A thing',
    number: 7,
    subscriberIds: [ACTOR, 'wants-all', 'no-email', 'no-inbox'],
    team: { identifier: 'ENG' },
  };
  return {
    workspace: { findUnique: async () => ({ name: 'W', slug: 'w' }) },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        USERS.find((user) => user.id === where.id),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        USERS.filter((user) => where.id.in.includes(user.id)),
    },
    issueComment: {
      findUnique: async () => ({
        id: 'comment-1',
        body: null as string | null,
        issue,
      }),
    },
    notification: {
      create: jest.fn(),
      findFirst: async (): Promise<null> => null,
    },
  };
}

describe('delivering a comment notification', () => {
  beforeEach(() => sendMail.mockReset());

  it('emails only the people who still want comment email', async () => {
    await emailHandler(fakePrisma() as never, commentPayload());

    expect(sendMail.mock.calls.map(([mail]) => mail.to).sort()).toEqual([
      'all@x',
      'no-inbox@x',
    ]);
  });

  it('writes inbox rows only for people who still want them', async () => {
    const prisma = fakePrisma();
    await vantikHandler(prisma as never, commentPayload());

    expect(
      prisma.notification.create.mock.calls
        .map(([{ data }]) => data.userId)
        .sort(),
    ).toEqual(['no-email', 'wants-all']);
  });
});
