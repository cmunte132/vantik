import { EventEmitter } from 'events';

const mockClients: MockClient[] = [];
const mockServices: MockService[] = [];
let slotExists = true;

class MockClient extends EventEmitter {
  query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM pg_publication')) {
      return { rows: [{}] };
    }
    if (sql.includes('FROM pg_replication_slots')) {
      return { rows: slotExists ? [{}] : [] };
    }
    return { rows: [{}] };
  });
  connect = jest.fn(async (): Promise<void> => undefined);
  end = jest.fn(async (): Promise<void> => undefined);
  constructor() {
    super();
    mockClients.push(this);
  }
}

class MockService extends EventEmitter {
  subscribe = jest.fn(() => new Promise<void>(() => undefined as void));
  destroy = jest.fn(async (): Promise<this> => {
    this.removeAllListeners();
    return this;
  });
  constructor() {
    super();
    mockServices.push(this);
  }
}

jest.mock('pg', () => ({ Client: MockClient }));
jest.mock('pg-logical-replication', () => ({
  LogicalReplicationService: MockService,
  PgoutputPlugin: class {},
}));

import ReplicationService from './replication.service';

const build = () => {
  const syncRepair = {
    reconcile: jest.fn(async (): Promise<void> => undefined),
  };
  const service = new ReplicationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    syncRepair as never,
  );
  return { service, syncRepair };
};

// Lets the awaited steps of reconnect() run.
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

describe('ReplicationService reconnect', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockClients.length = 0;
    mockServices.length = 0;
    slotExists = true;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not throw on a control client error', () => {
    build();
    expect(() =>
      mockClients[0].emit('error', new Error('Connection terminated')),
    ).not.toThrow();
  });

  it('reconnects to the same slot after a stream error', async () => {
    const { service, syncRepair } = build();
    await service.setupReplication();
    const first = mockServices[0];

    expect(() =>
      first.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();

    await jest.advanceTimersByTimeAsync(1000);
    await flush();

    expect(first.destroy).toHaveBeenCalled();
    expect(mockServices).toHaveLength(2);
    expect(mockServices[1].subscribe).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^vantik_replication_slot_/),
    );
    expect(syncRepair.reconcile).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('recreates the slot and repairs the log when the slot is gone', async () => {
    const { service, syncRepair } = build();
    await service.setupReplication();
    slotExists = false;

    mockServices[0].emit('error', new Error('Connection terminated'));
    await jest.advanceTimersByTimeAsync(1000);
    await flush();

    const queries = mockClients.flatMap((c) =>
      c.query.mock.calls.map((call) => String(call[0])),
    );
    expect(
      queries.some((q) => q.includes('pg_create_logical_replication_slot')),
    ).toBe(true);
    expect(syncRepair.reconcile).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('schedules one retry for repeated errors', async () => {
    const { service } = build();
    await service.setupReplication();
    mockServices[0].emit('error', new Error('Connection terminated'));
    mockServices[0].emit('error', new Error('Connection terminated'));

    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(mockServices).toHaveLength(2);
    await service.onModuleDestroy();
  });

  it('backs off exponentially, caps the delay and resets on start', async () => {
    const { service } = build();
    await service.setupReplication();

    // Make each reconnect fail at the control connection.
    const failing = jest
      .spyOn(
        service as unknown as { ensureSlotExists: () => Promise<boolean> },
        'ensureSlotExists',
      )
      .mockRejectedValue(new Error('down'));

    mockServices[0].emit('error', new Error('x'));
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const delay of delays) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      const before = failing.mock.calls.length;
      await jest.advanceTimersByTimeAsync(1);
      await flush();
      expect(failing.mock.calls.length).toBe(before + 1);
    }

    failing.mockRestore();
    await jest.advanceTimersByTimeAsync(30000);
    await flush();
    const latest = mockServices[mockServices.length - 1];
    latest.emit('start');
    latest.emit('error', new Error('x'));
    const count = mockServices.length;
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(mockServices.length).toBe(count + 1);
    await service.onModuleDestroy();
  });

  it('stops reconnecting after module destroy', async () => {
    const { service } = build();
    await service.setupReplication();
    mockServices[0].emit('error', new Error('Connection terminated'));
    await service.onModuleDestroy();

    await jest.advanceTimersByTimeAsync(60000);
    await flush();
    expect(mockServices).toHaveLength(1);
  });
});
