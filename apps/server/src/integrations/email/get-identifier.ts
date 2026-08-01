import { type PluginContext } from 'plugins/plugin.interface';

export const getIdentifier = async (
  ctx: PluginContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
) => {
  const deliveredTo = data.to;
  const matches = deliveredTo.match(/\+([^-]+)-([^@]+)@/i);
  let workspaceSlug = null;

  if (matches && matches.length === 3) {
    [, workspaceSlug] = matches;
  }

  if (!workspaceSlug) {
    return null;
  }

  // Update the integration account with the new configuration in the database
  const integrationAccount = await ctx.account.byWorkspaceSlug(
    'email',
    workspaceSlug,
  );

  if (integrationAccount) {
    return integrationAccount.accountId;
  }

  return null;
};
