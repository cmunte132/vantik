import { ActionTypesEnum, ModelNameEnum } from '@vantikhq/types';

import { IntegrationEventsService } from './integration-events.service';

const GITHUB = {
  slug: 'github',
  egress: [] as string[],
  onRecord: [{ event: ActionTypesEnum.ON_CREATE, model: ModelNameEnum.Issue }],
  webhooks: true,
};
const QUIET = { slug: 'local-repo', egress: [] as string[] };

function build(
  accounts: Array<{ id: string; slug: string }>,
  add = jest.fn(async () => ({ id: 'job' })),
) {
  const prisma = {
    integrationAccount: {
      findMany: jest.fn(async () =>
        accounts.map(({ id, slug }) => ({
          id,
          integrationDefinition: { slug },
        })),
      ),
    },
  };
  const integrations = {
    pluginSpecOf: jest.fn(async (slug: string) =>
      slug === 'github' ? GITHUB : QUIET,
    ),
  };
  const queue = { add };

  const service = new IntegrationEventsService(
    prisma as never,
    integrations as never,
    queue as never,
  );

  return { service, prisma, queue };
}

const change = {
  modelName: ModelNameEnum.Issue,
  modelId: 'issue-1',
  tag: 'insert',
  changedData: { title: 'x' },
  workspaceId: 'workspace-1',
  lsn: '0/16B3748',
};

describe('a record change and the integrations connected to it', () => {
  it('goes to each connected account whose plugin subscribes', async () => {
    const { service, queue } = build([
      { id: 'account-gh', slug: 'github' },
      { id: 'account-local', slug: 'local-repo' },
    ]);

    await service.recordChanged(change);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        slug: 'github',
        integrationAccountId: 'account-gh',
        event: ActionTypesEnum.ON_CREATE,
        payload: expect.objectContaining({
          type: ModelNameEnum.Issue,
          modelId: 'issue-1',
        }),
      }),
      expect.anything(),
    );
  });

  it('asks only for workspace accounts of the workspace that changed', async () => {
    const { service, prisma } = build([]);

    await service.recordChanged(change);

    expect(prisma.integrationAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'workspace-1', personal: false, deleted: null },
      }),
    );
  });

  it('names the job by the change, so each replica queues it once', async () => {
    // Every replica has its own replication slot and sees the same change.
    const { service, queue } = build([{ id: 'account-gh', slug: 'github' }]);

    await service.recordChanged(change);
    await service.recordChanged(change);

    const ids = queue.add.mock.calls.map(
      (call: unknown[]) => (call[2] as { jobId: string }).jobId,
    );
    expect(ids).toEqual([
      'account-gh:Issue:issue-1:0/16B3748',
      'account-gh:Issue:issue-1:0/16B3748',
    ]);
  });

  it('ignores an event the plugin did not subscribe to', async () => {
    const { service, queue } = build([{ id: 'account-gh', slug: 'github' }]);

    await service.recordChanged({ ...change, tag: 'update' });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('turns no soft delete into an event', async () => {
    const { service, prisma, queue } = build([
      { id: 'account-gh', slug: 'github' },
    ]);

    await service.recordChanged({ ...change, tag: 'delete' });

    expect(prisma.integrationAccount.findMany).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not fail the change when the queue is down', async () => {
    const { service } = build(
      [{ id: 'account-gh', slug: 'github' }],
      jest.fn(async () => {
        throw new Error('redis is down');
      }),
    );

    await expect(service.recordChanged(change)).resolves.toBeUndefined();
  });
});

describe('a webhook and the plugin it belongs to', () => {
  const delivery = {
    workspaceId: 'workspace-1',
    integrationAccountId: 'account-1',
    eventBody: { action: 'created' },
    eventHeaders: {},
  };

  it('is queued for a plugin that takes webhooks', async () => {
    const { service, queue } = build([]);

    await service.webhookReceived({ ...delivery, slug: 'github' });

    expect(queue.add).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        event: ActionTypesEnum.SOURCE_WEBHOOK,
        integrationAccountId: 'account-1',
        payload: { eventBody: { action: 'created' }, eventHeaders: {} },
      }),
      expect.anything(),
    );
  });

  it('is dropped for a plugin that declares none', async () => {
    const { service, queue } = build([]);

    await service.webhookReceived({ ...delivery, slug: 'local-repo' });

    expect(queue.add).not.toHaveBeenCalled();
  });
});
