/**
 * Which account a webhook is handed to.
 *
 * The webhook route is unauthenticated, so the account named in the body is
 * the only thing that decides which workspace the event lands in.
 */
import type { Response } from 'express';

import { IntegrationPayloadEventType } from '@vantikhq/types';

import WebhookService from './webhook.service';

function build(accountId: unknown) {
  const integrations = {
    loadIntegration: jest.fn(
      async (_slug: string, payload: { event: string }) =>
        payload.event === IntegrationPayloadEventType.GET_CONNECTED_ACCOUNT_ID
          ? accountId
          : true,
    ),
  };
  const prisma = {
    integrationAccount: {
      findFirst: jest.fn(async () => ({
        id: 'account-1',
        workspaceId: 'workspace-1',
      })),
    },
    actionEntity: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
  };
  const moduleRoutingQueue = {
    routeWebhook: jest.fn(async (): Promise<void> => undefined),
  };

  const service = new WebhookService(
    prisma as never,
    integrations as never,
    moduleRoutingQueue as never,
    { run: jest.fn() } as never,
  );

  return { service, prisma, moduleRoutingQueue };
}

function handle(service: WebhookService) {
  const response = {
    status: () => ({ send: jest.fn(), json: jest.fn() }),
  } as unknown as Response;

  return service.handleEvents(response, 'github', {}, {}, {});
}

describe('a webhook and the account it belongs to', () => {
  it.each([
    ['cannot be read from the body', undefined],
    ['is empty', ''],
    ['is not a string', null],
  ])('goes nowhere when the account %s', async (_case, accountId) => {
    // Undefined reached Prisma as "no filter", and the event went to the
    // first account in the table.
    const { service, prisma, moduleRoutingQueue } = build(accountId);

    await expect(handle(service)).resolves.toBeNull();
    expect(prisma.integrationAccount.findFirst).not.toHaveBeenCalled();
    expect(moduleRoutingQueue.routeWebhook).not.toHaveBeenCalled();
  });

  it('looks the account up within the provider that sent it', async () => {
    const { service, prisma } = build('12345');

    await handle(service);

    expect(prisma.integrationAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId: '12345',
          integrationDefinition: { slug: 'github' },
          personal: false,
          deleted: null,
        },
      }),
    );
  });

  it('routes the change for the account it found', async () => {
    const { service, moduleRoutingQueue } = build('12345');

    await handle(service);

    expect(moduleRoutingQueue.routeWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceName: 'github',
        integrationAccountId: 'account-1',
        workspaceId: 'workspace-1',
      }),
    );
  });
});
