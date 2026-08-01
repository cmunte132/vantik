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
