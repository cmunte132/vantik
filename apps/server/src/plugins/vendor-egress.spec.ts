import { PluginContextFactory } from './plugin-context.factory';
import { type PluginSpec } from './plugin.interface';

/**
 * The egress allowlist, which is the only part of this contract that is a
 * security control rather than a tidiness one.
 *
 * A plugin says what to call and the host decides whether it may. If that check
 * can be walked around with a path, the whole design reduces to a naming
 * convention.
 */
describe('reaching a vendor', () => {
  const account = {
    id: 'acc-1',
    integrationDefinition: { config: { botToken: 'super-secret' } },
  };

  const prisma = {
    integrationAccount: { findUnique: jest.fn().mockResolvedValue(account) },
  };

  const spec: PluginSpec = {
    slug: 'discord',
    baseUrl: 'https://discord.com/api/v10',
    egress: ['discord.com'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth: (a: any) => `Bot ${a?.integrationDefinition?.config?.botToken}`,
  };

  function ctxWith(pluginSpec?: PluginSpec) {
    return new PluginContextFactory(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ).build('discord', 'ws-1', 'user-1', pluginSpec, 'acc-1');
  }

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as never;
  });

  it('attaches the credential the plugin never sees', async () => {
    await ctxWith(spec).vendor.fetch('/channels/1/messages/2');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://discord.com/api/v10/channels/1/messages/2');
    expect(init.headers.Authorization).toBe('Bot super-secret');
  });

  /**
   * The check that matters. A relative path is resolved against the base URL
   * *before* the host is compared, so none of these spellings escape.
   */
  it('refuses a host outside the allowlist, however it is spelled', async () => {
    const ctx = ctxWith(spec);

    for (const path of [
      'https://evil.com/steal',
      '//evil.com/steal',
      'https://discord.com.evil.com/steal',
    ]) {
      await expect(ctx.vendor.fetch(path)).rejects.toThrow('may not reach');
    }

    expect(global.fetch).not.toHaveBeenCalled();
  });

  /** Declaring nothing means reaching nothing, rather than reaching anything. */
  it('refuses every call when the plugin declared no spec', async () => {
    await expect(ctxWith(undefined).vendor.fetch('/anything')).rejects.toThrow(
      'cannot call a vendor',
    );

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
