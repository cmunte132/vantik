import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import supertokens, { RecipeUserId } from 'supertokens-node';
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

/**
 * A credential to mint a session against, for an account.
 *
 * The inverse of the lookup `createNewSession` performs. Minting a session
 * needs a SuperTokens *recipe* user id, and callers that hold only an account
 * id — no live session to read one from — have to resolve one. Passing the
 * account id straight to `convertToRecipeUserId` builds a well-formed id that
 * belongs to nobody, and `createNewSession` then rejects it.
 *
 * An account reachable by both a login code and a passkey has an identity per
 * credential; any of them authenticates the same account, so the oldest is
 * taken for a stable choice.
 */
export async function getRecipeUserIdForAccount(
  prisma: PrismaService,
  appUserId: string,
): Promise<RecipeUserId> {
  const identity = await prisma.authIdentity.findFirst({
    where: { userId: appUserId },
    orderBy: { createdAt: 'asc' },
    select: { supertokensUserId: true },
  });

  if (!identity) {
    throw new UnauthorizedException(
      `No credential is registered for account ${appUserId}.`,
    );
  }

  return supertokens.convertToRecipeUserId(identity.supertokensUserId);
}
