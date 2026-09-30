import { MailerService } from '@nestjs-modules/mailer';
import { Request, Response } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { isSessionValid } from 'common/authentication';
import { getAuthenticatedIdentity } from 'modules/sync/sync.utils';

import { AuthSessionContext } from './auth.interface';
import { AuthService, SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, sha256Hex } from './auth.service';

function fixture(expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)) {
  const token = 'session-lifetime-token';
  let row: {
    id: string; tokenHash: string; userId: string; expiresAt: Date;
    workspaceId: string; role: string;
    user: { id: string; usersOnWorkspaces: { workspaceId: string; role: string }[] };
  } | null = {
    id: 'session', tokenHash: sha256Hex(token), userId: 'user', expiresAt,
    workspaceId: 'workspace', role: 'ADMIN',
    user: { id: 'user', usersOnWorkspaces: [{ workspaceId: 'workspace', role: 'ADMIN' }] },
  };
  const prisma = {
    session: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => row?.tokenHash === where.tokenHash ? { ...row } : null,
      updateMany: async ({ where, data }: {
        where: { id: string; expiresAt: { gt: Date } }; data: { expiresAt: Date };
      }) => {
        if (!row || row.id !== where.id || row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        row.expiresAt = data.expiresAt;
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: { id: string; expiresAt: { lte: Date } } }) => {
        if (!row || row.id !== where.id || row.expiresAt > where.expiresAt.lte) return { count: 0 };
        row = null;
        return { count: 1 };
      },
    },
  };
  const service = new AuthService(prisma as unknown as PrismaService, {} as MailerService);
  const cookie = jest.fn();
  const res = { cookie } as unknown as Response;
  return { service, token, res, cookie, expiry: () => row?.expiresAt, revoke: () => { row = null; } };
}

describe('browser session sliding lifetime', () => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-10-01T00:00:00Z')); });
  afterEach(() => { jest.useRealTimers(); });

  it('keeps socket and bearer lookups read-only so a later HTTP cookie request can renew both expiries', async () => {
    const f = fixture();
    const originalExpiry = f.expiry()!;
    expect(await getAuthenticatedIdentity({ cookie: `${SESSION_COOKIE_NAME}=${f.token}` }, f.service)).toEqual({
      userId: 'user', workspaceId: 'workspace', sessionId: 'session',
    });
    expect(f.expiry()).toEqual(originalExpiry);

    const bearerRequest = { headers: { authorization: `Bearer ${f.token}` }, cookies: {} } as Request & { session?: AuthSessionContext };
    expect(await isSessionValid(bearerRequest, {} as never, f.service)).toBe(true);
    expect(bearerRequest.session?.getUserId()).toBe('user');
    expect(f.expiry()).toEqual(originalExpiry);
    expect(f.cookie).not.toHaveBeenCalled();

    const browserRequest = { cookies: { [SESSION_COOKIE_NAME]: f.token } };
    const session = await f.service.resolveRequestSession(browserRequest, f.token, f.res);
    expect(session?.getUserId()).toBe('user');
    expect(f.expiry()).toEqual(new Date(Date.now() + SESSION_MAX_AGE_MS));
    expect(f.cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, f.token, expect.objectContaining({ maxAge: SESSION_MAX_AGE_MS, httpOnly: true }));

    jest.setSystemTime(new Date(originalExpiry.getTime() + 1));
    expect((await f.service.resolveRequestSession({}, f.token, f.res))?.getUserId()).toBe('user');
  });

  it('can renew the cookie after a response-free lookup in the same HTTP request', async () => {
    const f = fixture();
    const request = {};
    const originalExpiry = f.expiry();
    const session = await f.service.resolveRequestSession(request, f.token);
    expect(session?.getUserId()).toBe('user');
    expect(f.expiry()).toEqual(originalExpiry);
    const results = await Promise.all([
      f.service.resolveRequestSession(request, f.token, f.res),
      f.service.resolveRequestSession(request, f.token, f.res),
    ]);
    expect(results.map((result) => result?.getUserId())).toEqual(['user', 'user']);
    expect(f.expiry()).toEqual(new Date(Date.now() + SESSION_MAX_AGE_MS));
  });

  it('does not turn a revoked cached session into an authenticated renewed cookie', async () => {
    const f = fixture();
    const request = {};
    expect((await f.service.resolveRequestSession(request, f.token))?.getUserId()).toBe('user');
    f.revoke();
    expect(await f.service.resolveRequestSession(request, f.token, f.res)).toBeNull();
    expect(await f.service.resolveRequestSession(request, f.token)).toBeNull();
    expect(f.cookie).not.toHaveBeenCalled();
  });

  it('rejects an expired socket session instead of extending its lifetime', async () => {
    const f = fixture(new Date());
    expect(await getAuthenticatedIdentity({ cookie: `${SESSION_COOKIE_NAME}=${f.token}` }, f.service)).toBeNull();
    expect(f.cookie).not.toHaveBeenCalled();
  });
});
