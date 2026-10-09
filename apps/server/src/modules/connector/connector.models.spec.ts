import { CONNECTOR_PROTOCOL_VERSION } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { ConnectorGateway } from './connector.gateway';
import { ConnectorRegistry, sanitizeModels } from './connector.registry';

/** The models a connector reports: stored, capped, and replaced on change. */

const PERSON = { workspaceId: 'ws-1', userId: 'user-1' };

const hello = {
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  connectorVersion: '0.1.0',
  hostname: 'laptop',
  ompVersion: '18.8.6' as string | null,
  ompAgentDir: true,
};

const model = (id: string) => ({
  provider: 'p',
  id,
  name: id,
  reasoning: true,
  thinkingLevels: ['low', 'high'],
});

function socket() {
  return {
    id: 'socket-1',
    data: { peer: PERSON } as Record<string, unknown>,
    disconnect: jest.fn(),
    timeout: jest.fn(() => ({ emitWithAck: jest.fn() })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asSocket = (value: ReturnType<typeof socket>): any => value;

function setup() {
  const registry = new ConnectorRegistry();
  const door = new ConnectorGateway({} as PrismaService, registry);
  return { door, registry, s: socket() };
}

describe('ConnectorGateway models', () => {
  it('stores the models and default from hello', () => {
    const { door, registry, s } = setup();

    door.accept(asSocket(s), {
      ...hello,
      models: [model('a')],
      defaultModel: 'p/a',
    });

    expect(registry.get(PERSON)?.hello).toMatchObject({
      models: [model('a')],
      defaultModel: 'p/a',
    });
  });

  it('caps the models and drops entries that are not strings', () => {
    const { door, registry, s } = setup();
    const many = Array.from({ length: 1500 }, (_, i) => model(`m${i}`));

    door.accept(asSocket(s), { ...hello, models: many });

    expect(registry.get(PERSON)?.hello.models).toHaveLength(1000);
    expect(
      sanitizeModels([{ provider: 1, id: 'x' }, model('ok'), null], 42),
    ).toEqual({ models: [model('ok')], defaultModel: null });
    expect(sanitizeModels('nope', null)).toBeNull();
  });

  it('replaces the models on a models event, and refuses one before hello', () => {
    const { door, registry, s } = setup();

    expect(
      door.updateModels(asSocket(s), { models: [], defaultModel: null }),
    ).toMatchObject({ ok: false });

    door.accept(asSocket(s), { ...hello, models: [model('a')] });
    expect(
      door.updateModels(asSocket(s), {
        models: [model('b')],
        defaultModel: 'p/b',
      }),
    ).toEqual({ ok: true });
    expect(registry.get(PERSON)?.hello).toMatchObject({
      models: [model('b')],
      defaultModel: 'p/b',
    });

    expect(door.updateModels(asSocket(s), { models: 'x' })).toMatchObject({
      ok: false,
    });
  });
});
