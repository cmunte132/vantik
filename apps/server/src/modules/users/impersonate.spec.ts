import { NotFoundException } from '@nestjs/common';
import { Response } from 'express';

import { UsersService } from './users.service';

// A successful impersonation is a new session for the target; stub the
// recipe and assert on who it was made for.
const createNewSession = jest.fn();
jest.mock('supertokens-node/recipe/session', () => ({
  __esModule: true,
  default: {
    createNewSession: (...args: unknown[]) => createNewSession(...args),
  },
}));

jest.mock('modules/auth/session-user', () => ({
  ...jest.requireActual('modules/auth/session-user'),
  getRecipeUserIdForAccount: jest.fn(
    async (_prisma: unknown, userId: string) => `recipe-${userId}`,
  ),
}));

const REQUEST = {} as never;
const DATABASE_PASSWORD = 'docker';
const KEY = 'a-long-random-impersonation-key';

describe('impersonating a user', () => {
  const originalEnv = process.env;
  let service: UsersService;
  let res: Response & { send: jest.Mock };

  beforeEach(() => {
    createNewSession.mockReset();
    process.env = { ...originalEnv, POSTGRES_PASSWORD: DATABASE_PASSWORD };
    delete process.env.IMPERSONATION_KEY;

    const prisma = {
      user: {
        findUnique: jest.fn(async ({ where }) =>
          where.id === 'user-target' ? { id: 'user-target' } : null,
        ),
      },
    };
    service = new UsersService(prisma as never);
    res = { send: jest.fn() } as never;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('is off when no key is configured', async () => {
    // It used to take the database password, which the install docs set to
    // "docker": anyone signed in could become anyone.
    await expect(
      service.impersonate(DATABASE_PASSWORD, 'user-target', res, REQUEST),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(createNewSession).not.toHaveBeenCalled();
  });

  it('refuses a wrong key, the database password included', async () => {
    process.env.IMPERSONATION_KEY = KEY;

    for (const key of [DATABASE_PASSWORD, `${KEY}x`, '']) {
      await expect(
        service.impersonate(key, 'user-target', res, REQUEST),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(createNewSession).not.toHaveBeenCalled();
  });

  it('signs in as the user with the configured key', async () => {
    process.env.IMPERSONATION_KEY = KEY;

    await service.impersonate(KEY, 'user-target', res, REQUEST);

    expect(createNewSession).toHaveBeenCalledWith(
      {},
      res,
      'public',
      'recipe-user-target',
    );
  });

  it('makes no session for a user that does not exist', async () => {
    // The lookup wasn't awaited, so this check never fired.
    process.env.IMPERSONATION_KEY = KEY;

    await expect(
      service.impersonate(KEY, 'user-missing', res, REQUEST),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(createNewSession).not.toHaveBeenCalled();
  });
});
