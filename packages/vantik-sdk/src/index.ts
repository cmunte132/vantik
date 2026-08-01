export * from '@vantikhq/services';
export * from '@vantikhq/types';

/**
 * A no-op logger, kept so an action still compiles while it is being ported.
 *
 * This re-exported trigger.dev's logger, which bound the SDK — and everything
 * importing it — to a service that is optional and, on a default deployment,
 * absent. A plugin logs through `ctx.log` now, which the host owns and routes
 * into the server's own logger with the plugin's slug attached. See ENG-89.
 */
export const logger = {
  /* eslint-disable no-console */
  log: (...args: unknown[]) => console.log(...args),
  info: (...args: unknown[]) => console.info(...args),
  debug: (...args: unknown[]) => console.debug(...args),
  error: (...args: unknown[]) => console.error(...args),
  /* eslint-enable no-console */
};
