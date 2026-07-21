import { UnauthorizedException } from '@nestjs/common';
import { SessionContainer } from 'supertokens-node/recipe/session';

/**
 * The account a session belongs to.
 *
 * `session.getUserId()` returns the SuperTokens *recipe* user id — the
 * credential that was used, not the person using it. Those were once the same
 * value, back when a `User` row was keyed on whatever SuperTokens minted, but
 * an account can now be reached by a login code and a passkey alike and each
 * carries its own recipe user id. `createNewSession` resolves the account once
 * and stamps it into the token, which is what this reads.
 *
 * A session issued before that change has no `appUserId`. There is nothing
 * useful to fall back to, so it is rejected and the holder signs in again.
 */
export function getAppUserId(session: SessionContainer): string {
  const appUserId = session.getAccessTokenPayload().appUserId;

  if (!appUserId) {
    throw new UnauthorizedException(
      'This session predates the account id it needs. Please sign in again.',
    );
  }

  return appUserId;
}
