import { type PluginContext } from 'plugins/plugin.interface';

import { getAccessToken, getBotAccessToken } from './utils';

export const getToken = async (
  ctx: PluginContext,
  integrationAccountId: string,
) => {
  const integrationAccount = await ctx.account.get(integrationAccountId);

  const token = await getAccessToken(ctx, integrationAccount);
  const botToken = await getBotAccessToken(integrationAccount);

  return { token, botToken };
};

/**
 * The installation token alone, which is all reading a repository needs.
 * Skipping the person's token also skips refreshing it, a call to GitHub of
 * its own that a citation check would otherwise make for every file.
 */
export const getBotToken = async (
  ctx: PluginContext,
  integrationAccountId: string,
) => getBotAccessToken(await ctx.account.get(integrationAccountId));
