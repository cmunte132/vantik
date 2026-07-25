import { hasValidPat } from './authentication';

/**
 * A personal access token names the workspace it was issued for, and that is the
 * workspace its requests should act in.
 *
 * The claims are built here rather than minted by SuperTokens, so the choice is
 * ours to get right: reading the account's *first* membership instead — which is
 * all a browser session can do, since it is not issued for any one workspace —
 * meant a token for one workspace silently answered for another the moment its
 * owner joined a second.
 */
function usersService(
  principal: {
    supertokensUserId?: string | null;
    membership?: { workspaceId: string; role: string } | null;
  } | null = {},
) {
  return {
    resolvePat: jest.fn().mockResolvedValue(
      principal && {
        userId: 'user-1',
        supertokensUserId:
          principal.supertokensUserId === undefined
            ? 'st-1'
            : principal.supertokensUserId,
        membership:
          principal.membership === undefined
            ? { workspaceId: 'ws-second', role: 'AGENT' }
            : principal.membership,
      },
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function request(token = 'tg_pat_abc') {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('hasValidPat', () => {
  it('claims the workspace the token was issued for, not the first one', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = request();

    await expect(hasValidPat(req, usersService())).resolves.toBe(true);
    expect(req.session.getAccessTokenPayload()).toEqual({
      appUserId: 'user-1',
      workspaceId: 'ws-second',
      role: 'AGENT',
    });
  });

  it('carries the role held in that workspace', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = request();

    await hasValidPat(
      req,
      usersService({ membership: { workspaceId: 'ws-first', role: 'ADMIN' } }),
    );

    expect(req.session.getAccessTokenPayload()).toMatchObject({
      workspaceId: 'ws-first',
      role: 'ADMIN',
    });
  });

  it('rejects a token nobody holds', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = request();

    await expect(hasValidPat(req, usersService(null))).resolves.toBe(false);
    expect(req.session).toBeUndefined();
  });

  it('rejects an account with no way in', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = request();

    await expect(
      hasValidPat(req, usersService({ supertokensUserId: null })),
    ).resolves.toBe(false);
  });

  it('rejects a request carrying no bearer token at all', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = { headers: {} };

    await expect(hasValidPat(req, usersService())).resolves.toBe(false);
  });

  /**
   * An account in no workspace, or no longer in the one its token names.
   * Answering with some *other* workspace it happens to belong to is the bug
   * this exists to prevent, and a session with no workspace at all is worse
   * still: `@Workspace()` yields undefined, Prisma drops the clause, and a
   * scoped read answers with every workspace's rows. So it authenticates
   * nobody.
   */
  it('rejects a token whose membership is gone rather than claiming no workspace', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = request();

    await expect(
      hasValidPat(req, usersService({ membership: null })),
    ).resolves.toBe(false);
    expect(req.session).toBeUndefined();
  });
});
