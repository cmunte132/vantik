/**
 * Where the stack under test lives. The defaults are what
 * `docker compose -f docker-compose.yaml -f docker-compose.e2e.yaml up` and
 * `pnpm dev` publish, so a local run needs no configuration.
 */

function url(name: string, fallback: string): string {
  return (process.env[name] || fallback).replace(/\/+$/, '');
}

/** The API server, addressed directly rather than through the webapp proxy. */
export const SERVER_URL = url('E2E_SERVER_URL', 'http://localhost:3001');

/** The webapp, which also proxies `/api/*` to the server. */
export const WEBAPP_URL = url('E2E_WEBAPP_URL', 'http://localhost:3000');

/** The Mailpit HTTP API the login emails are read from. */
export const MAILPIT_URL = url('E2E_MAILPIT_URL', 'http://localhost:8025');

/** Where the setup project leaves the accounts it provisions for the run. */
export const ACCOUNTS_FILE = `${__dirname}/../.auth/accounts.json`;

/**
 * Distinguishes this run's records from every earlier run's. Workspace slugs
 * are unique across the server and are derived from the workspace name, so a
 * suite that reuses a name fails on its second run against the same database.
 */
export function runTag(): string {
  return (
    process.env.E2E_RUN_TAG ||
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  );
}
