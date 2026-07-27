import { PrismaService } from 'nestjs-prisma';
import supertokens from 'supertokens-node';
import { SessionContainer } from 'supertokens-node/recipe/session';

/** What the API actually reads off a session, and nothing more. */
export interface PatSessionClaims {
  appUserId: string;
  workspaceId: string;
  role: string;
  /**
   * The token this request came in on. Present only for PAT requests — a
   * browser session is not issued for a token and has none.
   *
   * Per-token limits need to name the token, not just the account: an account
   * can hold several, and a budget spent per account would let one noisy
   * harness exhaust the allowance of every other harness signed in as the same
   * agent.
   */
  tokenId?: string;
}

/** The token on an Authorization header, or null when there is not one. */
export function bearerToken(header?: string): string | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }

  return header.slice(7).trim() || null;
}

/** Whether a bearer token is one of ours rather than a JWT we have to verify. */
export function isPatToken(token?: string | null): boolean {
  return Boolean(token?.startsWith('tg_pat_'));
}

/**
 * Who a personal access token speaks for: the account, a credential to answer
 * `getUserId()` with, and the membership it holds in the workspace the token
 * was issued for.
 *
 * `membership` is null when the account is in no workspace, or is no longer in
 * the one the token names — a token is issued for one workspace and has no
 * business answering for another, so there is deliberately nothing to fall
 * back to and such a token authenticates nobody.
 */
export interface PatPrincipal {
  userId: string;
  /** The token row itself, so per-token limits have something to key on. */
  tokenId: string;
  /** Any credential belonging to the account; null when it has no way in. */
  supertokensUserId: string | null;
  membership: { workspaceId: string; role: string; settings: unknown } | null;
  /** Last recorded use, for deciding whether it is worth recording again. */
  lastUsedAt: Date | null;
}

/**
 * How stale a token's `lastUsedAt` may get before it is written again.
 *
 * The value answers "is this credential still in use", which nobody asks to
 * the minute. Writing on every request would put a row update on the hot path
 * of the one principal that calls in a loop, to sharpen a timestamp no screen
 * displays that precisely.
 */
export const TOKEN_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Records that a token was just used, if it is worth recording.
 *
 * Deliberately not awaited by callers and deliberately swallowing its own
 * failure: this is bookkeeping, and a request that did real work must not fail
 * — or wait — because a timestamp could not be written.
 */
export function touchToken(
  prisma: PrismaService,
  principal: PatPrincipal,
): void {
  const last = principal.lastUsedAt?.getTime() ?? 0;

  if (Date.now() - last < TOKEN_LAST_USED_THROTTLE_MS) {
    return;
  }

  const now = new Date();
  // Keep the request's cached principal in step, so several guards on one
  // request do not each decide a write is due.
  principal.lastUsedAt = now;

  void prisma.personalAccessToken
    .update({ where: { id: principal.tokenId }, data: { lastUsedAt: now } })
    .catch((): void => undefined);
}

/**
 * Resolves a token to its principal in one query, once per request.
 *
 * Both the scope guard and token authentication need the same facts, and the
 * guard runs first, so resolving it twice would double the cost of every
 * agent's call — and an agent's calls are the ones on a loop. Passing the
 * request lets the second asker read what the first already looked up;
 * correctness does not depend on the order, only the query count.
 */
export async function resolvePatPrincipal(
  prisma: PrismaService,
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request?: any,
): Promise<PatPrincipal | null> {
  if (request?.patPrincipal?.token === token) {
    return request.patPrincipal.principal;
  }

  const pat = await prisma.personalAccessToken.findFirst({
    where: { token, deleted: null },
    select: {
      id: true,
      userId: true,
      workspaceId: true,
      lastUsedAt: true,
      user: {
        select: {
          authIdentities: {
            select: { supertokensUserId: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
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
    supertokensUserId: pat.user.authIdentities[0]?.supertokensUserId ?? null,
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

/**
 * A session context for a personal access token, held in memory for the length
 * of one request.
 *
 * Token auth used to call `createNewSessionWithoutRequestResponse` on every
 * request purely to get an object the rest of the API could read claims off.
 * That persisted a `session_info` row per request, so the table grew with API
 * traffic instead of with logins — invisible when only people logged in, and
 * unbounded once agents started calling on a loop.
 *
 * Nothing about a PAT request needs a persisted session: the token is the
 * credential, it is verified against the database on the way in, and it is
 * revoked by deleting its row. What the request needs is the claims, so this
 * builds those directly.
 *
 * Only the members the codebase actually uses are implemented. Anything else on
 * `SessionContainer` describes a refreshable browser session and has no honest
 * answer here, so it throws rather than returning a plausible-looking lie.
 */
export function createPatSession(
  claims: PatSessionClaims,
  supertokensUserId: string,
): SessionContainer {
  const session = {
    getAccessTokenPayload: () => claims,
    getUserId: () => supertokensUserId,
    // A RecipeUserId object, not the bare string: callers hand this straight to
    // createNewSession, which asks it for getAsString(). Unlike an account id,
    // this one really is a recipe user id, so converting it names a credential
    // that exists.
    getRecipeUserId: () => supertokens.convertToRecipeUserId(supertokensUserId),
    getTenantId: () => 'public',
    getHandle: () => `pat:${claims.appUserId}`,
    getAccessToken: () => {
      throw new Error(
        'A personal access token request has no access token to hand out; the token itself is the credential.',
      );
    },
  };

  return session as unknown as SessionContainer;
}
