import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { getAppUserId, getRecipeUserIdForAccount } from './session-user';

const sessionWith = (payload: Record<string, unknown>) =>
  ({ getAccessTokenPayload: () => payload }) as never;

describe('getAppUserId', () => {
  it('reads the account id stamped into the token', () => {
    expect(getAppUserId(sessionWith({ appUserId: 'account-1' }))).toBe(
      'account-1',
    );
  });

  it('rejects a session minted before the account id existed', () => {
    expect(() => getAppUserId(sessionWith({}))).toThrow(UnauthorizedException);
  });
});

describe('getRecipeUserIdForAccount', () => {
  const prismaWith = (identity: { supertokensUserId: string } | null) =>
    ({
      authIdentity: { findFirst: async () => identity },
    }) as unknown as PrismaService;

  // The bug this exists to stop: an account id handed to
  // convertToRecipeUserId builds a well-formed id belonging to nobody, and
  // createNewSession then rejects it — which broke onboarding, invite accept,
  // impersonation and action tokens alike.
  it('resolves the credential rather than echoing the account id', async () => {
    const recipeUserId = await getRecipeUserIdForAccount(
      prismaWith({ supertokensUserId: 'recipe-1' }),
      'account-1',
    );

    expect(recipeUserId.getAsString()).toBe('recipe-1');
    expect(recipeUserId.getAsString()).not.toBe('account-1');
  });

  it('refuses an account with no credential instead of inventing one', async () => {
    await expect(
      getRecipeUserIdForAccount(prismaWith(null), 'account-1'),
    ).rejects.toThrow(UnauthorizedException);
  });
});
