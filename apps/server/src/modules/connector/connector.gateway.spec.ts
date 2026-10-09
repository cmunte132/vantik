import { CONNECTOR_PROTOCOL_VERSION } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { ConnectorGateway } from './connector.gateway';
import {
  ConnectorRegistry,
  type ConnectorRunHandler,
} from './connector.registry';

/**
 * The connector's door: who gets in, what hello records, and that nothing is
 * accepted from a socket that has not said hello.
 */

const PERSON = { workspaceId: 'ws-1', userId: 'user-1' };

function gateway(
  principal: { role: string; workspaceId?: string } | null | 'none',
) {
  const prisma = {
    personalAccessToken: {
      findFirst: jest.fn().mockResolvedValue(
        principal === null
          ? null
          : {
              id: 'pat-1',
              userId: PERSON.userId,
              workspaceId: PERSON.workspaceId,
              lastUsedAt: null,
              user: {
                usersOnWorkspaces:
                  principal === 'none'
                    ? []
                    : [
                        {
                          workspaceId:
                            principal.workspaceId ?? PERSON.workspaceId,
                          role: principal.role,
                          settings: null,
                        },
                      ],
              },
            },
      ),
    },
  } as unknown as PrismaService;
  const registry = new ConnectorRegistry();

  return { gateway: new ConnectorGateway(prisma, registry), registry };
}

function socket(token?: unknown, id = 'socket-1') {
  return {
    id,
    data: {} as Record<string, unknown>,
    handshake: { auth: token === undefined ? {} : { token } },
    disconnect: jest.fn(),
    timeout: jest.fn(() => ({ emitWithAck: jest.fn() })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asSocket = (value: ReturnType<typeof socket>): any => value;

const hello = {
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  connectorVersion: '0.1.0',
  hostname: 'laptop',
  ompVersion: '18.8.6' as string | null,
  ompAgentDir: true,
};

describe('ConnectorGateway handshake', () => {
  it('lets a person in with their own token', async () => {
    const { gateway: door } = gateway({ role: 'ADMIN' });
    const s = socket('tg_pat_good');

    await door.authenticate(asSocket(s));

    expect(s.data.peer).toEqual(PERSON);
  });

  it('refuses a handshake with no token', async () => {
    const { gateway: door } = gateway({ role: 'ADMIN' });

    await expect(door.authenticate(asSocket(socket()))).rejects.toThrow(
      /CLI token/,
    );
  });

  it('refuses something that is not a CLI token', async () => {
    const { gateway: door } = gateway({ role: 'ADMIN' });

    await expect(
      door.authenticate(asSocket(socket('not-a-pat'))),
    ).rejects.toThrow(/CLI token/);
  });

  it('refuses a token nobody holds, or that has expired', async () => {
    const { gateway: door } = gateway(null);

    await expect(
      door.authenticate(asSocket(socket('tg_pat_gone'))),
    ).rejects.toThrow(/not valid, or it has expired/);
  });

  it('refuses a token with no membership in its workspace', async () => {
    const { gateway: door } = gateway('none');

    await expect(
      door.authenticate(asSocket(socket('tg_pat_orphan'))),
    ).rejects.toThrow(/workspace you belong to/);
  });

  it('refuses an agent token', async () => {
    const { gateway: door } = gateway({ role: 'AGENT' });

    await expect(
      door.authenticate(asSocket(socket('tg_pat_agent'))),
    ).rejects.toThrow(/agent token cannot run a connector/);
  });
});

describe('ConnectorGateway hello', () => {
  async function connected() {
    const made = gateway({ role: 'MEMBER' });
    const s = socket('tg_pat_good');
    await made.gateway.authenticate(asSocket(s));
    return { ...made, s };
  }

  it('registers the connector and acknowledges with who it is', async () => {
    const { gateway: door, registry, s } = await connected();

    expect(door.accept(asSocket(s), hello)).toEqual({
      ok: true,
      userId: PERSON.userId,
      workspaceId: PERSON.workspaceId,
    });
    expect(registry.get(PERSON)?.hello).toMatchObject({
      hostname: 'laptop',
      ompVersion: '18.8.6',
    });
  });

  it('refuses a different protocol version, and says what to do', async () => {
    const { gateway: door, registry, s } = await connected();

    const ack = door.accept(asSocket(s), {
      ...hello,
      protocolVersion: CONNECTOR_PROTOCOL_VERSION + 1,
    });

    expect(ack).toMatchObject({ ok: false });
    expect(ack.ok === false && ack.reason).toMatch(/Update the vantik CLI/);
    expect(registry.get(PERSON)).toBeUndefined();
  });

  it('refuses hello on a socket that was never authenticated', () => {
    const { gateway: door } = gateway({ role: 'MEMBER' });

    expect(door.accept(asSocket(socket()), hello)).toMatchObject({
      ok: false,
    });
  });

  it('removes the connector when the socket disconnects', async () => {
    const { gateway: door, registry, s } = await connected();
    door.accept(asSocket(s), hello);

    door.handleDisconnect(asSocket(s));

    expect(registry.get(PERSON)).toBeUndefined();
  });

  it('keeps the newer connection when the older one disconnects late', async () => {
    const { gateway: door, registry, s } = await connected();
    door.accept(asSocket(s), hello);

    const newer = socket('tg_pat_good', 'socket-2');
    await door.authenticate(asSocket(newer));
    door.accept(asSocket(newer), hello);

    // The older socket was told to leave; its disconnect arrives afterwards.
    expect(s.disconnect).toHaveBeenCalled();
    door.handleDisconnect(asSocket(s));

    expect(registry.get(PERSON)?.socket.id).toBe('socket-2');
  });

  it('tells the handler when a person goes offline', async () => {
    const { gateway: door, registry, s } = await connected();
    const handler: ConnectorRunHandler = {
      handle: jest.fn(),
      connected: jest.fn(),
      disconnected: jest.fn(),
    };
    registry.setHandler(handler);

    door.accept(asSocket(s), hello);
    door.handleDisconnect(asSocket(s));

    expect(handler.connected).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ hostname: 'laptop' }),
    );
    expect(handler.disconnected).toHaveBeenCalledWith(PERSON);
  });

  it('reports the loss of a replaced socket, then the new hello with its run list', async () => {
    const { gateway: door, registry, s } = await connected();
    const calls: string[] = [];
    const handler: ConnectorRunHandler = {
      handle: jest.fn(),
      connected: jest.fn((_peer, said) => {
        calls.push(`connected:${(said.activeRunIds ?? []).join(',')}`);
      }),
      disconnected: jest.fn(() => {
        calls.push('disconnected');
      }),
    };
    registry.setHandler(handler);

    door.accept(asSocket(s), hello);
    const second = socket('tg_pat_good');
    second.id = 'socket-2';
    await door.authenticate(asSocket(second));
    door.accept(asSocket(second), {
      ...hello,
      activeRunIds: ['run-1', 7] as unknown as string[],
    });

    expect(calls).toEqual(['connected:', 'disconnected', 'connected:run-1']);
  });
});

describe('ConnectorGateway run messages', () => {
  it('accepts none before hello', async () => {
    const { gateway: door, registry } = gateway({ role: 'MEMBER' });
    registry.setHandler({
      handle: jest.fn(),
      connected: jest.fn(),
      disconnected: jest.fn(),
    });
    const s = socket('tg_pat_good');
    await door.authenticate(asSocket(s));

    const ack = await door.forward(asSocket(s), 'run.events', {});

    expect(ack).toMatchObject({ ok: false });
  });

  it('hands a message to the handler as the person who said hello', async () => {
    const { gateway: door, registry } = gateway({ role: 'MEMBER' });
    const handle = jest.fn().mockResolvedValue({ ok: true });
    registry.setHandler({
      handle,
      connected: jest.fn(),
      disconnected: jest.fn(),
    });
    const s = socket('tg_pat_good');
    await door.authenticate(asSocket(s));
    door.accept(asSocket(s), hello);

    const ack = await door.forward(asSocket(s), 'run.events', { runId: 'r' });

    expect(ack).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledWith(PERSON, 'run.events', { runId: 'r' });
  });

  it('answers a handler that throws with a refusal, not a crash', async () => {
    const { gateway: door, registry } = gateway({ role: 'MEMBER' });
    registry.setHandler({
      handle: jest.fn().mockRejectedValue(new Error('boom')),
      connected: jest.fn(),
      disconnected: jest.fn(),
    });
    const s = socket('tg_pat_good');
    await door.authenticate(asSocket(s));
    door.accept(asSocket(s), hello);

    await expect(
      door.forward(asSocket(s), 'run.finished', {}),
    ).resolves.toMatchObject({ ok: false });
  });
});
