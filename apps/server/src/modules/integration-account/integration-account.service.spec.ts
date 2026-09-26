import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { IntegrationAccountService } from './integration-account.service';

function buildService(row: Record<string, unknown> | null) {
  const prisma = {
    integrationAccount: {
      findFirst: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({ id: 'account-1' }),
    },
  } as unknown as PrismaService;

  return { service: new IntegrationAccountService(prisma), prisma };
}

describe('IntegrationAccountService.deleteIntegrationAccount', () => {
  it('disconnects a workspace account for any member', async () => {
    const { service, prisma } = buildService({
      personal: false,
      integratedById: 'someone-else',
    });

    await service.deleteIntegrationAccount(
      { integrationAccountId: 'account-1' },
      'user-1',
    );

    expect(prisma.integrationAccount.update).toHaveBeenCalled();
  });

  it('disconnects a personal account for the person who connected it', async () => {
    const { service, prisma } = buildService({
      personal: true,
      integratedById: 'user-1',
    });

    await service.deleteIntegrationAccount(
      { integrationAccountId: 'account-1' },
      'user-1',
    );

    expect(prisma.integrationAccount.update).toHaveBeenCalled();
  });

  it('refuses to disconnect a teammate-s personal account', async () => {
    const { service, prisma } = buildService({
      personal: true,
      integratedById: 'someone-else',
    });

    await expect(
      service.deleteIntegrationAccount(
        { integrationAccountId: 'account-1' },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.integrationAccount.update).not.toHaveBeenCalled();
  });

  it('refuses an account that is already gone', async () => {
    const { service, prisma } = buildService(null);

    await expect(
      service.deleteIntegrationAccount(
        { integrationAccountId: 'account-1' },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.integrationAccount.update).not.toHaveBeenCalled();
  });
});
