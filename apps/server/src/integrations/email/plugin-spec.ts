import { type PluginSpec } from 'plugins/plugin.interface';

/**
 * What the email plugin declares about itself.
 *
 * Gmail's API is the only host it reaches. The credential is the OAuth token on
 * the account, which the plugin never reads — it was `integrationConfiguration
 * .token`, interpolated into an Authorization header by the plugin itself.
 */
export const emailSpec: PluginSpec = {
  slug: 'email',
  baseUrl: 'https://gmail.googleapis.com',
  egress: ['gmail.googleapis.com'],
  auth: (account) => {
    const token = account?.integrationConfiguration?.token;

    return token ? `Bearer ${token}` : undefined;
  },
};
