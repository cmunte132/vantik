import { createPatSession } from './pat-session';

const claims = { appUserId: 'user-1', workspaceId: 'ws-1', role: 'ADMIN' };

describe('createPatSession', () => {
  it('carries the claims the API reads off a session', () => {
    expect(createPatSession(claims, 'st-1').getAccessTokenPayload()).toEqual(
      claims,
    );
  });

  it('answers getUserId with the credential, not the account', () => {
    expect(createPatSession(claims, 'st-1').getUserId()).toBe('st-1');
  });

  it('refuses to hand out an access token it does not have', () => {
    expect(() => createPatSession(claims, 'st-1').getAccessToken()).toThrow(
      /the token itself is the credential/,
    );
  });
});
