import { createHash, createPrivateKey, sign } from 'crypto';

import { MailerService } from '@nestjs-modules/mailer';
import { PasskeyChallengeOperation } from '@prisma/client';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Request, Response } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { AuthController } from './auth.controller';
import { AuthService, PASSKEY_CHALLENGE_LIFETIME_MS, SESSION_COOKIE_NAME } from './auth.service';

const x = Buffer.from('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296', 'hex');
const y = Buffer.from('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5', 'hex');
const privateKey = createPrivateKey({
  format: 'jwk',
  key: {
    kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url'),
    d: Buffer.concat([Buffer.alloc(31), Buffer.from([1])]).toString('base64url'),
  },
});
const publicKey = Buffer.from(isoCBOR.encode(new Map<number, number | Uint8Array>([
  [1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(x)], [-3, new Uint8Array(y)],
])));
const credentialId = Buffer.from('security-regression-key').toString('base64url');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();

function clientData(challenge: string, type: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin: 'http://localhost:3000' }));
}

function registration(challenge: string) {
  const id = Buffer.from(credentialId, 'base64url');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  const authData = Buffer.concat([
    hash('localhost'), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, publicKey,
  ]);
  const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, never>>([
    ['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', new Uint8Array(authData)],
  ]));
  return {
    id: credentialId, rawId: credentialId, type: 'public-key' as const,
    response: {
      clientDataJSON: clientData(challenge, 'webauthn.create').toString('base64url'),
      attestationObject: Buffer.from(attestation).toString('base64url'),
      transports: ['internal' as const],
    },
    clientExtensionResults: {},
  };
}

function assertion(challenge: string, counter = 1) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([hash('localhost'), Buffer.from([0x05]), count]);
  const data = clientData(challenge, 'webauthn.get');
  return {
    id: credentialId, rawId: credentialId, type: 'public-key' as const,
    response: {
      clientDataJSON: data.toString('base64url'),
      authenticatorData: authenticatorData.toString('base64url'),
      signature: sign('sha256', Buffer.concat([authenticatorData, hash(data)]), privateKey).toString('base64url'),
    },
    clientExtensionResults: {},
  };
}

function fixture() {
  type User = { id: string; email: string };
  type Challenge = {
    challenge: string; operation: PasskeyChallengeOperation; userId?: string | null;
    email?: string | null; expiresAt: Date;
  };
  type Credential = {
    id: string; userId: string; publicKey: Buffer; counter: bigint; transports: string[];
  };
  const users = new Map<string, User>();
  const challenges = new Map<string, Challenge>();
  const credentials = new Map<string, Credential>();
  const sessions: string[] = [];
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) =>
        [...users.values()].find((user) => where.id ? user.id === where.id : user.email === where.email) ?? null,
      create: async ({ data }: { data: User }) => {
        if ([...users.values()].some((user) => user.email === data.email)) throw new Error('Duplicate email');
        users.set(data.id, data);
        return data;
      },
    },
    passkeyChallenge: {
      create: async ({ data }: { data: Challenge }) => { challenges.set(data.challenge, data); return data; },
      findUnique: async ({ where }: { where: { challenge: string } }) => challenges.get(where.challenge) ?? null,
      deleteMany: async ({ where }: { where: { challenge: string; operation: PasskeyChallengeOperation; expiresAt: { gt: Date } } }) => {
        const challenge = challenges.get(where.challenge);
        if (!challenge || challenge.operation !== where.operation || challenge.expiresAt <= where.expiresAt.gt) return { count: 0 };
        challenges.delete(where.challenge);
        return { count: 1 };
      },
    },
    passkeyCredential: {
      findMany: async ({ where }: { where: { userId: string } }) => [...credentials.values()].filter((credential) => credential.userId === where.userId),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const credential = credentials.get(where.id);
        return credential ? { ...credential, user: users.get(credential.userId)! } : null;
      },
      create: async ({ data }: { data: Credential }) => { credentials.set(data.id, data); return data; },
      update: async ({ where, data }: { where: { id: string }; data: { counter: bigint } }) => {
        const credential = credentials.get(where.id)!;
        Object.assign(credential, data);
        return credential;
      },
    },
    usersOnWorkspaces: { findFirst: async (): Promise<null> => null },
    session: { create: async ({ data }: { data: { userId: string } }) => { sessions.push(data.userId); return { id: `session-${sessions.length}` }; } },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  const service = new AuthService(prisma as unknown as PrismaService, {} as MailerService);
  const res = { cookie: jest.fn() } as unknown as Response;
  return { service, controller: new AuthController(service), users, challenges, credentials, sessions, res };
}

describe('passkey challenge and account security', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.FRONTEND_HOST = 'http://localhost:3000';
    process.env.PASSKEY_SIGNUP_ENABLED = 'true';
  });
  afterEach(() => { process.env = { ...originalEnv }; });

  it('creates an anonymous account only after a valid registration', async () => {
    const f = fixture();
    const { options, user } = await f.service.generatePasskeyRegistrationOptions({ email: ' New@Example.com ' });
    expect(f.users.size).toBe(0);
    const result = await f.service.verifyPasskeyRegistration({ email: 'new@example.com' }, options.challenge, registration(options.challenge), f.res);
    expect(result.verified).toBe(true);
    expect(f.users.get(user.id)?.email).toBe('new@example.com');
    expect(f.credentials.get(credentialId)?.userId).toBe(user.id);
    expect(f.sessions).toEqual([user.id]);
  });

  it('rejects existing anonymous email both before and after options issuance', async () => {
    const f = fixture();
    f.users.set('victim', { id: 'victim', email: 'victim@example.com' });
    await expect(f.service.generatePasskeyRegistrationOptions({ email: 'VICTIM@example.com' })).rejects.toThrow('Sign in');
    const { options } = await f.service.generatePasskeyRegistrationOptions({ email: 'race@example.com' });
    f.users.set('race', { id: 'race', email: 'race@example.com' });
    await expect(f.service.verifyPasskeyRegistration({ email: 'race@example.com' }, options.challenge, registration(options.challenge), f.res)).rejects.toThrow('Sign in');
    expect(f.credentials.size).toBe(0);
    expect(f.sessions).toEqual([]);
  });

  it('binds signup to its original email and never creates a user from a failed response', async () => {
    const f = fixture();
    const { options } = await f.service.generatePasskeyRegistrationOptions({ email: 'original@example.com' });
    await expect(f.service.verifyPasskeyRegistration({ email: 'other@example.com' }, options.challenge, registration(options.challenge), f.res)).rejects.toThrow('challenge');
    await expect(f.service.verifyPasskeyRegistration({ email: 'original@example.com' }, options.challenge, registration('attacker-selected'), f.res)).rejects.toThrow();
    expect(f.users.size).toBe(0);
    expect(f.credentials.size).toBe(0);
    expect(f.sessions).toEqual([]);
  });

  it('uses the authenticated account for settings add even with another or empty email', async () => {
    for (const email of ['victim@example.com', '']) {
      const f = fixture();
      f.users.set('owner', { id: 'owner', email: 'owner@example.com' });
      f.users.set('victim', { id: 'victim', email: 'victim@example.com' });
      jest.spyOn(f.service, 'resolveRequestSession').mockResolvedValue({ getUserId: () => 'owner' } as never);
      const req = { cookies: { [SESSION_COOKIE_NAME]: 'owner-token' } } as unknown as Request;
      const generated = await f.controller.registerOptions({ email }, req);
      if (generated.status !== 'OK' || !('options' in generated)) throw new Error('Registration refused');
      const result = await f.controller.registerVerify({ email, challenge: generated.options.challenge, response: registration(generated.options.challenge) }, req, f.res);
      expect(result.status).toBe('OK');
      expect(f.credentials.get(credentialId)?.userId).toBe('owner');
      expect([...f.users.values()].map((user) => user.email).sort()).toEqual(['owner@example.com', 'victim@example.com']);
      expect(f.sessions).toEqual([]);
    }
  });

  it('rejects registration under a different authenticated user', async () => {
    const f = fixture();
    f.users.set('owner', { id: 'owner', email: 'owner@example.com' });
    f.users.set('other', { id: 'other', email: 'other@example.com' });
    const { options } = await f.service.generatePasskeyRegistrationOptions({ userId: 'owner' });
    await expect(f.service.verifyPasskeyRegistration({ userId: 'other' }, options.challenge, registration(options.challenge), f.res)).rejects.toThrow('challenge');
    expect(f.credentials.size).toBe(0);
  });

  it('enforces the signup switch on verification but permits authenticated add', async () => {
    const f = fixture();
    const { options } = await f.service.generatePasskeyRegistrationOptions({ email: 'new@example.com' });
    process.env.PASSKEY_SIGNUP_ENABLED = 'false';
    await expect(f.service.verifyPasskeyRegistration({ email: 'new@example.com' }, options.challenge, registration(options.challenge), f.res)).rejects.toThrow('disabled');
    f.users.set('owner', { id: 'owner', email: 'owner@example.com' });
    const added = await f.service.generatePasskeyRegistrationOptions({ userId: 'owner' });
    expect((await f.service.verifyPasskeyRegistration({ userId: 'owner' }, added.options.challenge, registration(added.options.challenge), f.res)).verified).toBe(true);
    expect(f.users.size).toBe(1);
  });

  it('expires registration and consumes successful authenticated add exactly once', async () => {
    const f = fixture();
    f.users.set('owner', { id: 'owner', email: 'owner@example.com' });
    const expired = await f.service.generatePasskeyRegistrationOptions({ userId: 'owner' });
    f.challenges.get(expired.options.challenge)!.expiresAt = new Date(Date.now() - 1);
    await expect(f.service.verifyPasskeyRegistration({ userId: 'owner' }, expired.options.challenge, registration(expired.options.challenge), f.res)).rejects.toThrow('challenge');
    expect(f.credentials.size).toBe(0);
    const active = await f.service.generatePasskeyRegistrationOptions({ userId: 'owner' });
    expect((await f.service.verifyPasskeyRegistration({ userId: 'owner' }, active.options.challenge, registration(active.options.challenge), f.res)).verified).toBe(true);
    await expect(f.service.verifyPasskeyRegistration({ userId: 'owner' }, active.options.challenge, registration(active.options.challenge), f.res)).rejects.toThrow('challenge');
    expect(f.credentials.get(credentialId)?.userId).toBe('owner');
    expect(f.sessions).toEqual([]);
  });

  it('rejects a captured assertion against a different issued challenge', async () => {
    const f = fixture();
    f.users.set('owner', { id: 'owner', email: 'owner@example.com' });
    f.credentials.set(credentialId, { id: credentialId, userId: 'owner', publicKey, counter: 0n, transports: ['internal'] });
    const first = await f.service.generatePasskeyAuthenticationOptions();
    const second = await f.service.generatePasskeyAuthenticationOptions();
    await expect(f.service.verifyPasskeyAuthentication(second.challenge, assertion(first.challenge), f.res)).rejects.toThrow();
    await expect(f.service.verifyPasskeyAuthentication(second.challenge, assertion(second.challenge), f.res)).rejects.toThrow('challenge');
    expect(f.sessions).toEqual([]);
    expect(f.credentials.get(credentialId)?.counter).toBe(0n);
  });

  it('accepts a real signed assertion once and rejects concurrent replay', async () => {
    const f = fixture();
    f.users.set('owner', { id: 'owner', email: 'owner@example.com' });
    f.credentials.set(credentialId, { id: credentialId, userId: 'owner', publicKey, counter: 0n, transports: ['internal'] });
    const options = await f.service.generatePasskeyAuthenticationOptions();
    const response = assertion(options.challenge);
    const results = await Promise.allSettled([
      f.service.verifyPasskeyAuthentication(options.challenge, response, f.res),
      f.service.verifyPasskeyAuthentication(options.challenge, response, f.res),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled').map((result) => (result as PromiseFulfilledResult<{ verified: boolean }>).value.verified)).toEqual([true]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.sessions).toEqual(['owner']);
    await expect(f.service.verifyPasskeyAuthentication(options.challenge, response, f.res)).rejects.toThrow('challenge');
  });

  it('rejects arbitrary, expired, wrong-operation and email-mismatched sign-in challenges', async () => {
    const f = fixture();
    f.users.set('owner', { id: 'owner', email: 'owner@example.com' });
    f.credentials.set(credentialId, { id: credentialId, userId: 'owner', publicKey, counter: 0n, transports: ['internal'] });
    await expect(f.service.verifyPasskeyAuthentication('attacker-selected', assertion('attacker-selected'), f.res)).rejects.toThrow('challenge');
    const expired = await f.service.generatePasskeyAuthenticationOptions();
    f.challenges.get(expired.challenge)!.expiresAt = new Date(Date.now() - PASSKEY_CHALLENGE_LIFETIME_MS);
    await expect(f.service.verifyPasskeyAuthentication(expired.challenge, assertion(expired.challenge), f.res)).rejects.toThrow('challenge');
    const registrationOptions = await f.service.generatePasskeyRegistrationOptions({ userId: 'owner' });
    await expect(f.service.verifyPasskeyAuthentication(registrationOptions.options.challenge, assertion(registrationOptions.options.challenge), f.res)).rejects.toThrow('challenge');
    const restricted = await f.service.generatePasskeyAuthenticationOptions('other@example.com');
    await expect(f.service.verifyPasskeyAuthentication(restricted.challenge, assertion(restricted.challenge), f.res)).rejects.toThrow('Passkey not found');
    expect(f.sessions).toEqual([]);
    expect(f.credentials.get(credentialId)?.counter).toBe(0n);
  });
});
