import { type PluginSpec } from 'plugins/plugin.interface';

/**
 * What Discord declares about itself.
 *
 * `egress` is the whole point: `ctx.vendor.fetch` refuses any host not listed,
 * so a path that resolves somewhere else — an absolute URL, a `//host` — cannot
 * leave here. The list is exact hostnames because a wildcard is how an
 * allowlist stops being one.
 *
 * `auth` is how the host builds the header. The bot token lives on the
 * definition rather than the account because one bot serves every workspace on
 * a deployment; the plugin never reads it, which is the property that makes the
 * boundary worth having. Before this, `actions/discord/triggers/message.ts`
 * read `integrationDefinition.config.botToken` and logged a `discord.js` client
 * in with it.
 */
export const discordSpec: PluginSpec = {
  slug: 'discord',
  baseUrl: 'https://discord.com/api/v10',
  egress: ['discord.com'],
  auth: (account) => {
    const token = account?.integrationDefinition?.config?.botToken;

    return token ? `Bot ${token}` : undefined;
  },
};
