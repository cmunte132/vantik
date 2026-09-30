import { UnauthorizedException } from '@nestjs/common';

import { getAppUserId } from './session-user';

const sessionWith = (payload: Record<string, unknown>) =>
  ({ getAccessTokenPayload: () => payload }) as never;

describe('getAppUserId', () => {
  it('rejects a session minted before the account id existed', () => {
    expect(() => getAppUserId(sessionWith({}))).toThrow(UnauthorizedException);
  });
});
