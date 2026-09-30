import { isSessionValid } from './authentication';

describe('isSessionValid', () => {
  function authServiceResolving(session: unknown) {
    return {
      resolveRequestSession: jest.fn().mockResolvedValue(session),
    };
  }

  const aSession = {
    getUserId: () => 'user-1',
    getAccessTokenPayload: () => ({ appUserId: 'user-1', workspaceId: 'ws-1' }),
  };

  it('uses the explicit identity instead of a different user in the cookie jar', async () => {
    const cookieSession = { getUserId: () => 'cookie-user' };
    const bearerSession = { getUserId: () => 'bearer-user' };
    const authService = {
      resolveRequestSession: async (_request: object, token: string) =>
        token === 'explicit-session' ? bearerSession : cookieSession,
    };
    const req = {
      cookies: { sSessionToken: 'cookie-session' },
      headers: { authorization: 'Bearer explicit-session' },
      session: undefined as unknown,
    };

    await isSessionValid(req as never, {} as never, authService as never);

    expect((req.session as typeof bearerSession).getUserId()).toBe('bearer-user');
  });

  it('does not fall back to a cookie when the explicit credential is invalid', async () => {
    const authService = {
      resolveRequestSession: async (_request: object, token: string) =>
        token === 'valid-cookie' ? aSession : null,
    };
    const req = {
      cookies: { sSessionToken: 'valid-cookie' },
      headers: { authorization: 'Bearer revoked-session' },
    };

    await expect(
      isSessionValid(req as never, {} as never, authService as never),
    ).rejects.toThrow();
  });

  it('rejects a revoked or expired session', async () => {
    const authService = authServiceResolving(null);
    const req = { cookies: { sSessionToken: 'revoked' }, headers: {} };

    await expect(
      isSessionValid(req as never, {} as never, authService as never),
    ).rejects.toThrow();
  });

  it('rejects a request without a session or token', async () => {
    const authService = authServiceResolving(aSession);
    const req = { cookies: {}, headers: {} };

    await expect(
      isSessionValid(req as never, {} as never, authService as never),
    ).rejects.toThrow();
  });
});
