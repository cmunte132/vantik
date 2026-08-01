import { type PluginContext } from 'plugins/plugin.interface';

export const getToken = async (
  ctx: PluginContext,
  integrationAccountId: string,
) => {
  const integrationAccount = await ctx.account.get(integrationAccountId);

  const definitionConfig =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    integrationAccount.integrationDefinition.config as any;

  return { token: definitionConfig.botToken };
};
