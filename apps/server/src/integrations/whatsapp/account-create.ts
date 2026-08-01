import { createIntegrationAccount } from 'integrations/utils';
import { type PluginContext } from 'plugins/plugin.interface';

export const integrationCreate = async (
  ctx: PluginContext,
  userId: string,
  workspaceId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
) => {
  const { accountId, personal, integrationDefinition } = data;
  const integrationConfiguration = {
    sessionClientId: accountId,
  };

  // Update the integration account with the new configuration in the database

  const integrationAccount = await createIntegrationAccount(ctx, {
    userId,
    accountId,
    config: integrationConfiguration,
    workspaceId,
    integrationDefinitionId: integrationDefinition.id,
    personal,
  });

  // await triggerDevService.triggerTaskAsync(
  //   'common',
  //   'whatsapp',
  //   { integrationAccount },
  //   Env.PROD,
  // );

  return {
    message: `Created integration account ${integrationAccount.id}`,
  };
};
