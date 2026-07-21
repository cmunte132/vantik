import { Injectable } from '@nestjs/common';

/**
 * Settings the browser needs before it can talk to anything else.
 *
 * Every field here is served unauthenticated and ends up in the page, so it
 * must stay strictly public. Nothing secret belongs in this shape.
 */
export interface ClientConfig {
  /**
   * Origin the websocket gateway is reachable on. The gateway shares the
   * server's port but is not proxied through the webapp, so unlike the REST
   * API this cannot be a same-origin path.
   */
  socketHost: string;
  posthogKey: string;
  posthogHost: string;
  sentryDsn: string;
}

@Injectable()
export class ClientConfigService {
  getClientConfig(): ClientConfig {
    return {
      // NEXT_PUBLIC_BACKEND_HOST is the browser's view of the server, which
      // differs from BACKEND_HOST whenever the container network name is not
      // reachable from outside. Prefer it, fall back for plain local runs.
      socketHost:
        process.env.NEXT_PUBLIC_BACKEND_HOST ?? process.env.BACKEND_HOST ?? '',
      posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '',
      posthogHost:
        process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
    };
  }
}

export default ClientConfigService;
