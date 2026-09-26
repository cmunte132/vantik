import { sign } from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

import { verifyAccessToken } from './authentication';

jest.mock('jwks-rsa', () => ({
  JwksClient: jest.fn().mockImplementation(() => ({
    getSigningKey: jest.fn().mockResolvedValue({
      getPublicKey: () => 'shared-secret',
    }),
  })),
}));

/**
 * The websocket handshake verifies the browser's access token here. When the
 * keys came from BACKEND_HOST, a server that could not reach its own public
 * address turned every socket away, and live updates stopped.
 */
describe('verifyAccessToken', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = {
      ...env,
      BACKEND_HOST: 'http://unreachable.example:4001',
      SUPERTOKEN_CONNECTION_URI: 'http://supertokens:3567/;http://backup:3567',
    };
  });

  afterAll(() => {
    process.env = env;
  });

  it('reads the signing keys from the SuperTokens core, once', async () => {
    const token = sign({ appUserId: 'user-1' }, 'shared-secret', {
      keyid: 'k1',
    });

    await expect(verifyAccessToken(`Bearer ${token}`)).resolves.toMatchObject({
      appUserId: 'user-1',
    });
    await verifyAccessToken(`Bearer ${token}`);

    expect(JwksClient).toHaveBeenCalledTimes(1);
    expect(JwksClient).toHaveBeenCalledWith(
      expect.objectContaining({
        jwksUri: 'http://supertokens:3567/.well-known/jwks.json',
      }),
    );
  });

  it('answers null for a token it cannot verify', async () => {
    const forged = sign({ appUserId: 'user-1' }, 'another-secret', {
      keyid: 'k1',
    });

    await expect(verifyAccessToken(`Bearer ${forged}`)).resolves.toBeNull();
    await expect(verifyAccessToken('Bearer not-a-jwt')).resolves.toBeNull();
  });
});
