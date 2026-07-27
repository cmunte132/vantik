import {
  VantikAgent,
  VantikAuthError,
  VantikClient,
} from '@vantikhq/agent-core';
import { env } from 'std-env';

import { readAuthConfigProfile } from './configFiles';

/**
 * Builds a VantikAgent from whatever credentials are around, so the task
 * commands share one auth story with the rest of the CLI.
 *
 * Order of preference: the ACCESS_TOKEN/BASE_HOST environment (used in CI),
 * then the profile written by `vantik-cli login`, then agent-core's own
 * VANTIK_TOKEN/VANTIK_URL. The stored `apiUrl` is the app root (e.g.
 * https://app.vantik.dev); agent-core wants the API root, so the webapp's
 * `/api` proxy prefix is appended. VANTIK_URL is passed through as-is, since
 * that variable already names the API root, and when nothing points anywhere
 * agent-core falls back to the local server on :3001.
 */
export function resolveClient(): VantikClient {
  const profile = readAuthConfigProfile();

  const token = env.ACCESS_TOKEN ?? profile?.accessToken ?? env.VANTIK_TOKEN;

  if (!token) {
    throw new VantikAuthError(
      'Not logged in. Run `vantik-cli login`, or set VANTIK_TOKEN to a ' +
        'tg_pat_… value from Settings → Agents.',
    );
  }

  const appUrl = env.BASE_HOST ?? profile?.apiUrl;
  const baseUrl = appUrl ? `${appUrl.replace(/\/+$/, '')}/api` : env.VANTIK_URL;

  return new VantikClient({ token, baseUrl });
}

export function resolveAgent(): VantikAgent {
  const profile = readAuthConfigProfile();

  const token = env.ACCESS_TOKEN ?? profile?.accessToken ?? env.VANTIK_TOKEN;

  if (!token) {
    throw new VantikAuthError(
      'Not logged in. Run `vantik-cli login`, or set VANTIK_TOKEN to a ' +
        'tg_pat_… value from Settings → Agents.',
    );
  }

  const appUrl = env.BASE_HOST ?? profile?.apiUrl;
  const baseUrl = appUrl ? `${appUrl.replace(/\/+$/, '')}/api` : env.VANTIK_URL;

  return new VantikAgent({ token, baseUrl });
}
