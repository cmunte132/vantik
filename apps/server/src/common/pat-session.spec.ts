import { createHash } from 'crypto';

import { PrismaService } from 'nestjs-prisma';

import { resolvePatPrincipal } from './pat-session';

/**
 * A run-scoped token expires, and the lookup is where that is enforced: every
 * caller that authenticates a PAT goes through `resolvePatPrincipal`.
 */

const TOKEN = 'tg_pat_runscopedtoken';
const HASH = createHash('sha256').update(TOKEN).digest('hex');

interface Row {
  tokenHash: string;
  deleted: Date | null;
  expiresAt: Date | null;
}

/** A table that honours the three predicates the lookup builds. */
function prismaWith(row: Row) {
  return {
    personalAccessToken: {
      findFirst: jest.fn(({ where }) => {
        const expiryOk = (where.OR as Array<Record<string, unknown>>).some(
          (clause) => {
            const expiresAt = clause.expiresAt as null | { gt: Date };

            if (expiresAt === null) {
              return row.expiresAt === null;
            }

            return row.expiresAt !== null && row.expiresAt > expiresAt.gt;
          },
        );

        const hit =
          row.tokenHash === where.tokenHash &&
          row.deleted === where.deleted &&
          expiryOk;

        return Promise.resolve(
          hit
            ? {
                id: 'pat-1',
                userId: 'user-1',
                workspaceId: 'ws-1',
                lastUsedAt: null,
                user: {
                  usersOnWorkspaces: [
                    { workspaceId: 'ws-1', role: 'MEMBER', settings: null },
                  ],
                },
              }
            : null,
        );
      }),
    },
  } as unknown as PrismaService;
}

const minutes = (n: number) => new Date(Date.now() + n * 60_000);

describe('resolvePatPrincipal expiry', () => {
  it('accepts a token that has no expiry', async () => {
    const principal = await resolvePatPrincipal(
      prismaWith({ tokenHash: HASH, deleted: null, expiresAt: null }),
      TOKEN,
    );

    expect(principal?.userId).toBe('user-1');
  });

  it('accepts a token that expires later', async () => {
    const principal = await resolvePatPrincipal(
      prismaWith({ tokenHash: HASH, deleted: null, expiresAt: minutes(30) }),
      TOKEN,
    );

    expect(principal?.userId).toBe('user-1');
  });

  it('refuses a token that has expired', async () => {
    const principal = await resolvePatPrincipal(
      prismaWith({ tokenHash: HASH, deleted: null, expiresAt: minutes(-1) }),
      TOKEN,
    );

    expect(principal).toBeNull();
  });

  it('refuses a token that was revoked before it expired', async () => {
    const principal = await resolvePatPrincipal(
      prismaWith({
        tokenHash: HASH,
        deleted: new Date(),
        expiresAt: minutes(30),
      }),
      TOKEN,
    );

    expect(principal).toBeNull();
  });
});
