import { existsSync } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import { env } from 'std-env';
import { z } from 'zod';

import { login } from './login';
import {
  CommonCommandOptions,
  commonOptions,
  SkipLoggingError,
  wrapCommandAction,
} from '../cli/common';
import { Connector, waitForSocketUrl } from '../connector/connector';
import { PKG_ROOT } from '../consts';
import { readAuthConfigProfile } from '../utilities/configFiles';
import { getVersion } from '../utilities/getVersion';

const ConnectCommandOptions = CommonCommandOptions.extend({
  socketUrl: z.string().optional(),
});

export function configureConnectCommand(program: Command) {
  return commonOptions(
    program
      .command('connect')
      .description(
        'Run Vantik issues delegated to this machine with your own omp (oh-my-pi)',
      )
      .option(
        '--api-url <url>',
        'The Vantik app or server URL, instead of the one you logged in to',
      )
      .option(
        '--socket-url <url>',
        'The origin of the realtime gateway, when it is not the one the server announces',
      ),
  ).action(async (options) => {
    await wrapCommandAction(
      'connectCommand',
      ConnectCommandOptions,
      options,
      (opts) => connect(opts),
    );
  });
}

/** Where the build puts the Vantik extension for omp. */
function extensionPath(): string {
  const file = path.join(
    PKG_ROOT,
    'dist',
    'pi-extension',
    'vantik-extension.js',
  );
  if (!existsSync(file)) {
    throw new SkipLoggingError(
      `The Vantik extension is missing from ${file}. Reinstall @vantikhq/cli, or run pnpm build in packages/cli.`,
    );
  }
  return file;
}

async function connect(options: z.infer<typeof ConnectCommandOptions>) {
  const notLoggedIn =
    'You are not logged in. Run `vantik login`, then `vantik connect`.';
  const profile = readAuthConfigProfile();
  let token = env.ACCESS_TOKEN ?? profile?.accessToken;
  let apiUrl = options.apiUrl ?? env.BASE_HOST ?? profile?.apiUrl;

  if (!token) {
    if (!process.stdin.isTTY) {
      throw new SkipLoggingError(notLoggedIn);
    }
    if (options.apiUrl) {
      env.BASE_HOST = options.apiUrl;
    }
    const result = await login(true);
    token = result?.auth.accessToken;
    apiUrl ??= result?.auth.apiUrl;
  }
  if (!token || !apiUrl) {
    throw new SkipLoggingError(notLoggedIn);
  }

  const log = (message: string) => console.log(`vantik connect: ${message}`);
  const socketUrl = options.socketUrl ?? (await waitForSocketUrl(apiUrl, log));

  const connector = new Connector({
    socketUrl,
    apiUrl,
    token,
    connectorVersion: getVersion(),
    extensionPath: extensionPath(),
    log,
  });
  await connector.run();
  // The login prompt can leave stdin open, which would hold the process after
  // the connector has stopped.
  process.exit(process.exitCode ?? 0);
}
