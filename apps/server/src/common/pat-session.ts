import { createHash } from 'crypto';

import { PrismaService } from 'nestjs-prisma';

import { AuthSessionClaims, createAuthSessionContext } from 'modules/auth/auth.interface';

export function bearerToken(header?: string): string | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim() || null;
}

export function isPatToken(token?: string | null): boolean {
  return Boolean(token?.startsWith('tg_pat_'));
}

export interface PatPrincipal {
  userId: string;
  tokenId: string;
  membership: { workspaceId: string; role: string; settings: unknown } | null;
  lastUsedAt: Date | null;
}

export const TOKEN_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export function touchToken(
  prisma: PrismaService,
  principal: PatPrincipal,
): void {
  const last = principal.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - last < TOKEN_LAST_USED_THROTTLE_MS) {
    return;
  }

  const now = new Date();
  principal.lastUsedAt = now;

  void prisma.personalAccessToken
    .update({ where: { id: principal.tokenId }, data: { lastUsedAt: now } })
    .catch((): void => undefined);
}

export async function resolvePatPrincipal(
  prisma: PrismaService,
  token: string,
  request?: { patPrincipal?: { token: string; principal: PatPrincipal | null } },
): Promise<PatPrincipal | null> {
  if (request?.patPrincipal?.token === token) {
    return request.patPrincipal.principal;
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const pat = await prisma.personalAccessToken.findFirst({
    // A run-scoped token carries an expiry; a token with none does not expire.
    // Enforced in the query so no caller can resolve an expired token.
    where: {
      tokenHash,
      deleted: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: {
      id: true,
      userId: true,
      workspaceId: true,
      lastUsedAt: true,
      user: {
        select: {
          usersOnWorkspaces: {
            select: { workspaceId: true, role: true, settings: true },
          },
        },
      },
    },
  });

  const principal: PatPrincipal | null = pat && {
    userId: pat.userId,
    tokenId: pat.id,
    membership:
      pat.user.usersOnWorkspaces.find(
        (membership) => membership.workspaceId === pat.workspaceId,
      ) ?? null,
    lastUsedAt: pat.lastUsedAt,
  };

  if (request) {
    request.patPrincipal = { token, principal };
  }

  return principal;
}

export function createPatSession(claims: AuthSessionClaims) {
  return createAuthSessionContext(claims);
}
