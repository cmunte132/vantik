import { randomBytes } from 'crypto';

import { UnauthorizedException } from '@nestjs/common';
import { verify, decode, JwtPayload } from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';
import { Error as STError } from 'supertokens-node';
import supertokens from 'supertokens-node';
import Session from 'supertokens-node/recipe/session';
import { VerifySessionOptions } from 'supertokens-node/recipe/session';
import { createNewSessionWithoutRequestResponse } from 'supertokens-node/recipe/session';
import { verifySession } from 'supertokens-node/recipe/session/framework/express';

import { config } from 'common/configs/config';
import { bearerToken, createPatSession, isPatToken } from 'common/pat-session';

import { UsersService } from 'modules/users/users.service';

export async function getKey(jwt: string) {
  const decoded = decode(jwt, { complete: true });

  // SuperTokens serves JWKS under its apiBasePath. That path moved to
  // '/api/auth' to match where the browser reaches the auth routes; deriving the
  // URI from the same config value keeps this verifier from drifting away from
  // it again the way a hardcoded '/auth' did.
  const client = new JwksClient({
    jwksUri: `${process.env.BACKEND_HOST}${config.superToken.appInfo.apiBasePath}/jwt/jwks.json`,
  });

  const key = await client.getSigningKey(decoded.header.kid);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return key!.getPublicKey();
}

/**
 * Authenticates a personal access token and puts its session context on the
 * request.
 *
 * The PAT itself is the credential and stays valid until it is revoked. The
 * `jwt` column recorded at creation time is deliberately *not* consulted: it
 * holds a supertokens access token, which expires an hour after it is issued,
 * so verifying it here made every PAT die an hour after being created and no
 * amount of re-authenticating could revive it.
 *
 * Nothing is persisted. This used to mint a real SuperTokens session for one of
 * the account's credentials, which wrote a `session_info` row per request; the
 * only thing it got out of that was an object carrying the account's claims, so
 * it now builds those claims directly. Answers true when the token is good.
 *
 * The claims name the workspace the *token* was issued for. `createNewSession`
 * stamps the account's first workspace because a browser session is not issued
 * for any particular one; a token is, and taking the first membership instead
 * let a token for one workspace answer for another as soon as its owner joined
 * a second.
 */
export async function hasValidPat(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any,
  usersService: UsersService,
): Promise<boolean> {
  const token = bearerToken(request.headers['authorization']);

  if (!token) {
    return false;
  }

  const principal = await usersService.resolvePat(token, request);

  // An account with no way in is not one a token should speak for; this is the
  // same guard the session-minting path had, and it keeps `getUserId()`
  // answerable for anything that asks.
  //
  // Nor is an account that no longer holds the membership its token names. The
  // claims have no other workspace to honestly report, and a session carrying
  // no workspace is worse than no session: `@Workspace()` hands the handler
  // undefined, Prisma drops an undefined `where` clause, and a scoped read like
  // `GET /teams` turns into every team on the server. A token that can act in
  // no workspace authenticates nobody.
  if (!principal?.supertokensUserId || !principal.membership) {
    return false;
  }

  request.session = createPatSession(
    {
      appUserId: principal.userId,
      workspaceId: principal.membership.workspaceId,
      role: principal.membership.role,
      tokenId: principal.tokenId,
    },
    principal.supertokensUserId,
  );

  return true;
}

/**
 * Verifies an access token and returns its payload, or null if it is missing or
 * fails verification.
 *
 * `hasValidHeader` answers only "was this signed by us", which is not enough
 * for the websocket handshake: that needs the caller's identity to decide which
 * rooms the socket may join. Returning the payload lets the caller bind the
 * socket to the token's own subject rather than to a query parameter.
 */
export async function verifyAccessToken(
  authHeaderValue: string,
): Promise<JwtPayload | null> {
  const token = authHeaderValue?.split('Bearer ')[1];

  if (!token) {
    return null;
  }

  try {
    const publicKey = await getKey(token);
    const payload = verify(token, publicKey, {});

    // A string payload carries no claims, so it cannot identify anyone.
    return typeof payload === 'string' ? null : payload;
  } catch (e) {
    return null;
  }
}

export async function hasValidHeader(
  authHeaderValue: string,
  throwError: boolean = true,
) {
  authHeaderValue =
    authHeaderValue === undefined
      ? undefined
      : authHeaderValue.split('Bearer ')[1];

  if (authHeaderValue === undefined) {
    if (throwError) {
      throw new UnauthorizedException({
        message: 'Unauthorised',
      });
    }

    return false;
  }

  try {
    const publicKey = await getKey(authHeaderValue);
    verify(authHeaderValue, publicKey, {});
    return true;
  } catch (e) {
    if (throwError) {
      throw new UnauthorizedException({
        message: 'Unauthorised',
      });
    }
    return false;
  }
}

export async function isSessionValid(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  verifyOptions: VerifySessionOptions,
  usersService: UsersService,
): Promise<boolean> {
  let err = undefined;

  try {
    const session = await Session.getSession(request, response, {
      sessionRequired: false,
    });

    if (session !== undefined) {
      // API call from the frontend and session verification is successful..
      await verifySession({ ...verifyOptions })(request, response, (res) => {
        err = res;
      });
    } else {
      const authHeader = request.headers['authorization'];

      // A personal access token is checked against the database, not against
      // JWKS: it is our own credential, not something we signed. Verifying it
      // used to mean minting an access token just to verify it back, which is
      // what persisted a session row per request.
      if (isPatToken(bearerToken(authHeader))) {
        if (await hasValidPat(request, usersService)) {
          return true;
        }

        throw new UnauthorizedException({ message: 'Unauthorised' });
      }

      return hasValidHeader(authHeader);
    }

    if (response.headersSent) {
      throw new STError({
        message: 'RESPONSE_SENT',
        type: 'RESPONSE_SENT',
      });
    }

    if (err) {
      throw err;
    }
  } catch (err) {
    console.log(err);
    throw new UnauthorizedException({
      message: 'Unauthorised',
    });
  }

  return true;
}

export async function generateKeyForUserId(userId: string) {
  const session = await createNewSessionWithoutRequestResponse(
    'public',
    supertokens.convertToRecipeUserId(userId),
  );

  const accessToken = session.getAccessToken();
  return accessToken;
}

export function generatePersonalAccessToken(): string {
  const prefix = 'tg_pat_';
  const randomString = randomBytes(24)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '');

  return `${prefix}${randomString}`;
}
