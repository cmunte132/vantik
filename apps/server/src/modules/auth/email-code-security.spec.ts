import { MailerService } from '@nestjs-modules/mailer';
import { Response } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { AuthService, CODE_LIFETIME_MS, sha256Hex } from './auth.service';

function fixture(attempts = 0, expiresAt = new Date(Date.now() + CODE_LIFETIME_MS)) {
  const id = 'email-verification';
  let verification: {
    id: string; email: string; codeHash: string; linkTokenHash: string; attempts: number; expiresAt: Date;
  } | null = { id, email: 'person@example.invalid', codeHash: sha256Hex('123456'), linkTokenHash: sha256Hex('magic-link'), attempts, expiresAt };
  const sessions: string[] = [];
  const user = { id: 'user', email: 'person@example.invalid' };
  const prisma = {
    emailVerification: {
      findUnique: async () => verification && { ...verification },
      update: async ({ data }: { data: { attempts: number } }) => {
        if (!verification) throw new Error('Record not found');
        verification.attempts = data.attempts;
        return { ...verification };
      },
      delete: async () => {
        if (!verification) throw new Error('Record not found');
        const deleted = verification;
        verification = null;
        return deleted;
      },
      updateManyAndReturn: async ({ where, data }: {
        where: { id: string; expiresAt: { gt: Date }; attempts: { lt: number } };
        data: { attempts: { increment: number } };
      }) => {
        if (!verification || verification.id !== where.id || verification.expiresAt <= where.expiresAt.gt || verification.attempts >= where.attempts.lt) return [];
        verification.attempts += data.attempts.increment;
        return [{ ...verification }];
      },
      deleteMany: async ({ where }: { where: { id: string; expiresAt: { gt: Date } } }) => {
        if (!verification || verification.id !== where.id || verification.expiresAt <= where.expiresAt.gt) return { count: 0 };
        verification = null;
        return { count: 1 };
      },
    },
    user: { upsert: async () => user },
    usersOnWorkspaces: { findFirst: async (): Promise<null> => null },
    session: { create: async ({ data }: { data: { userId: string } }) => {
      sessions.push(data.userId);
      return { id: `session-${sessions.length}` };
    } },
  };
  const service = new AuthService(prisma as unknown as PrismaService, {} as MailerService);
  const res = { cookie: jest.fn() } as unknown as Response;
  return { service, id, res, sessions };
}

describe('email code attempt and consumption limits', () => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-10-01T00:00:00Z')); });
  afterEach(() => { jest.useRealTimers(); });

  it('accepts only five concurrent wrong guesses and prevents a later correct login', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => f.service.consumeEmailCode(f.id, '000000', f.res)));
    const failures = results.filter((result) => result.status === 'INCORRECT_USER_INPUT_CODE_ERROR');
    expect(failures.map((result) => result.failedCodeInputAttemptCount).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(results.filter((result) => result.status === 'RESTART_FLOW_ERROR')).toHaveLength(7);
    expect(await f.service.consumeEmailCode(f.id, '123456', f.res)).toEqual({ status: 'RESTART_FLOW_ERROR' });
    expect(f.sessions).toEqual([]);
  });

  it('keeps the normal retry counts and allows a correct fifth attempt', async () => {
    const f = fixture();
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(await f.service.consumeEmailCode(f.id, '000000', f.res)).toEqual({
        status: 'INCORRECT_USER_INPUT_CODE_ERROR', maximumCodeInputAttempts: 5, failedCodeInputAttemptCount: attempt,
      });
    }
    expect(await f.service.consumeEmailCode(f.id, ' 123456 ', f.res)).toMatchObject({ status: 'OK', user: { id: 'user' } });
    expect(await f.service.consumeEmailCode(f.id, '123456', f.res)).toEqual({ status: 'RESTART_FLOW_ERROR' });
    expect(f.sessions).toEqual(['user']);
  });

  it('creates one session when correct and wrong guesses race', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.consumeEmailCode(f.id, '123456', f.res),
      f.service.consumeEmailCode(f.id, '000000', f.res),
      f.service.consumeEmailCode(f.id, '123456', f.res),
      f.service.consumeEmailCode(f.id, '000000', f.res),
    ]);
    expect(results.filter((result) => result.status === 'OK')).toEqual([
      { status: 'OK', user: { id: 'user', email: 'person@example.invalid' } },
    ]);
    expect(f.sessions).toEqual(['user']);
  });

  it('consumes a shared verification once when its code and magic link race', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.consumeEmailCode(f.id, '123456', f.res),
      f.service.consumeMagicLink(f.id, 'magic-link', f.res),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['OK', 'RESTART_FLOW_ERROR']);
    expect(f.sessions).toEqual(['user']);
  });

  it('does not allow a concurrent correct guess after the fifth attempt is reserved', async () => {
    const f = fixture(4);
    const results = await Promise.all([
      f.service.consumeEmailCode(f.id, '000000', f.res),
      f.service.consumeEmailCode(f.id, '123456', f.res),
    ]);
    expect(results).toEqual([
      { status: 'INCORRECT_USER_INPUT_CODE_ERROR', maximumCodeInputAttempts: 5, failedCodeInputAttemptCount: 5 },
      { status: 'RESTART_FLOW_ERROR' },
    ]);
    expect(f.sessions).toEqual([]);
  });

  it('rejects a code at its expiry boundary without a session', async () => {
    const f = fixture(0, new Date());
    expect(await f.service.consumeEmailCode(f.id, '123456', f.res)).toEqual({ status: 'RESTART_FLOW_ERROR' });
    expect(f.sessions).toEqual([]);
  });
});
