import { randomBytes } from 'crypto';

import { UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { bearerToken, createPatSession, isPatToken } from 'common/pat-session';

import { AuthSessionContext } from 'modules/auth/auth.interface';
import { AuthService, sessionTokenFromRequest } from 'modules/auth/auth.service';
import { UsersService } from 'modules/users/users.service';

/**
 * Authenticates a personal access token and puts its session context on the request.
 */
export async function hasValidPat(
  request: Request & { session?: AuthSessionContext },
  usersService: UsersService,
): Promise<boolean> {
  const token = bearerToken(request.headers?.['authorization']);
  if (!token) {
    return false;
  }

  const principal = await usersService.resolvePat(token, request);
  if (!principal || !principal.membership) {
    return false;
  }

  request.session = createPatSession({
    appUserId: principal.userId,
    workspaceId: principal.membership.workspaceId,
    role: principal.membership.role,
    tokenId: principal.tokenId,
  });

  return true;
}

/**
 * Authenticates a request with a personal access token, a session cookie, or
 * a session token in the Authorization header, and puts the auth context on
 * the request.
 */
export async function isSessionValid(
  request: Request & { session?: AuthSessionContext },
  usersService: UsersService,
  authService: AuthService,
): Promise<boolean> {
  const token = bearerToken(request.headers?.['authorization']);

  if (isPatToken(token)) {
    if (await hasValidPat(request, usersService)) {
      return true;
    }
    throw new UnauthorizedException({ message: 'Unauthorised' });
  }

  // An explicit bearer token takes priority over the browser's cookie.
  const sessionToken = token ?? sessionTokenFromRequest(request);

  if (sessionToken) {
    const sessionContext = await authService.resolveRequestSession(
      request,
      sessionToken,
    );
    if (sessionContext) {
      request.session = sessionContext;
      return true;
    }
  }

  throw new UnauthorizedException({ message: 'Unauthorised' });
}

export function generatePersonalAccessToken(): string {
  const prefix = 'tg_pat_';
  const randomString = randomBytes(24)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '');

  return `${prefix}${randomString}`;
}
