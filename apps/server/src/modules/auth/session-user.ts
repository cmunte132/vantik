import { UnauthorizedException } from '@nestjs/common';

import { AuthSessionContext } from './auth.interface';

/**
 * Returns the account id from the authenticated session context.
 */
export function getAppUserId(session: AuthSessionContext): string {
  const appUserId = session?.getAccessTokenPayload()?.appUserId;

  if (!appUserId) {
    throw new UnauthorizedException(
      'This session predates the account id it needs. Please sign in again.',
    );
  }

  return appUserId;
}
