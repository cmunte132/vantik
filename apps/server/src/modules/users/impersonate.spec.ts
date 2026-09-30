import { NotFoundException } from '@nestjs/common';
import { Response } from 'express';

import { UsersService } from './users.service';

import { AuthService } from 'modules/auth/auth.service';

const REQUEST = {} as never;
const DOCUMENTED_DEFAULT = 'docker';
const KEY = 'a-long-random-impersonation-key';

describe('impersonating a user', () => {
  const originalEnv = process.env;
  let service: UsersService;
  let authService: { createSession: jest.Mock };
  let res: Response & { send: jest.Mock };

  beforeEach(() => {
    authService = { createSession: jest.fn().mockResolvedValue({}) };
    process.env = { ...originalEnv, POSTGRES_PASSWORD: DOCUMENTED_DEFAULT };
    delete process.env.IMPERSONATION_KEY;

    const prisma = {
      user: {
        findUnique: jest.fn(async ({ where }) =>
          where.id === 'user-target' ? { id: 'user-target' } : null,
        ),
      },
    };
    service = new UsersService(prisma as never, authService as unknown as AuthService);
    res = { send: jest.fn() } as never;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('is off when no key is configured', async () => {
    // It used to take the database password, which the install docs set to
    // "docker": anyone signed in could become anyone.
    await expect(
      service.impersonate(DOCUMENTED_DEFAULT, 'user-target', res, REQUEST),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(authService.createSession).not.toHaveBeenCalled();
  });

  it('refuses a wrong key, the database password included', async () => {
    process.env.IMPERSONATION_KEY = KEY;

    for (const key of [DOCUMENTED_DEFAULT, `${KEY}x`, '']) {
      await expect(
        service.impersonate(key, 'user-target', res, REQUEST),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(authService.createSession).not.toHaveBeenCalled();
  });

  it('signs in as the user with the configured key', async () => {
    process.env.IMPERSONATION_KEY = KEY;

    await service.impersonate(KEY, 'user-target', res, REQUEST);

    expect(authService.createSession).toHaveBeenCalledWith('user-target', res);
  });

  it('makes no session for a user that does not exist', async () => {
    // The lookup wasn't awaited, so this check never fired.
    process.env.IMPERSONATION_KEY = KEY;

    await expect(
      service.impersonate(KEY, 'user-missing', res, REQUEST),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(authService.createSession).not.toHaveBeenCalled();
  });
});
