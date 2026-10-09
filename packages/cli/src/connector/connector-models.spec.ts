import type { ConnectorModels } from '@vantikhq/types';

import { Connector } from './connector';

describe('the models a hello reports', () => {
  const install = { version: '18.8.6', agentDir: true };
  const model = {
    provider: 'p',
    id: 'm',
    name: 'M',
    reasoning: false,
    thinkingLevels: null,
  };

  function connectorWith(discover: () => Promise<ConnectorModels>) {
    const log = jest.fn();
    const emit = jest.fn();
    const connector = new Connector({
      socketUrl: 'http://x',
      apiUrl: 'http://x',
      token: 't',
      connectorVersion: '1',
      extensionPath: '/e.js',
      log,
      discoverModels: discover,
    });
    (connector as unknown as { socket: unknown }).socket = {
      connected: true,
      emit,
    };
    return { connector, emit, log };
  }

  it('carries the discovered models and default, and sends `models` only on a change', async () => {
    let result: ConnectorModels = { models: [model], defaultModel: 'p/m' };
    const { connector, emit } = connectorWith(async () => result);

    expect(connector.hello(install).models).toBeUndefined();

    await connector.refreshModels(true);
    expect(connector.hello(install)).toMatchObject({
      models: [model],
      defaultModel: 'p/m',
    });
    expect(emit).not.toHaveBeenCalled();

    await connector.refreshModels(false);
    expect(emit).not.toHaveBeenCalled();

    result = { models: [model], defaultModel: 'p/other' };
    await connector.refreshModels(false);
    expect(emit).toHaveBeenCalledWith('models', result, expect.any(Function));
  });

  it('survives a failed discovery', async () => {
    const { connector, log } = connectorWith(async () => {
      throw new Error('timed out');
    });
    await connector.refreshModels(true);
    expect(connector.hello(install).models).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });
});
