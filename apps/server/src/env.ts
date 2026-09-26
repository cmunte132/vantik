/**
 * Loads the environment before anything reads it.
 *
 * Every setting the server has is read from `process.env`, and many are read
 * the moment their module is imported: the queue crons, the run and page
 * limits, the OpenTelemetry exporter. So the file is loaded here, as the first
 * import of `main.ts`, rather than by a Nest module that only runs once all of
 * those imports have already happened.
 *
 * A variable already in the environment wins over the file. That is how the
 * compose stack and `dotenv-cli` hand them over, and it means this file only
 * fills gaps. The file is looked for in the working directory and then at the
 * repo root, so starting the server from `apps/server` finds the same `.env`
 * as starting it from the root.
 *
 * `.env` builds values out of other values (`DATABASE_URL` out of `DB_HOST`
 * and friends), so it is read with dotenv-expand, as `dotenv-cli` reads it.
 * Node's own `process.loadEnvFile` would leave `${DB_HOST}` in the URL.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config } from 'dotenv';
import { expand } from 'dotenv-expand';

/**
 * What the server cannot boot without.
 *
 * Each of these, when missing, fails somewhere far from its cause: Typesense
 * reports a missing `apiKey`, SuperTokens a missing `apiDomain`, and CORS a
 * TypeError on `split`. Naming them here turns that into one sentence.
 */
const REQUIRED = [
  'DATABASE_URL',
  'FRONTEND_HOST',
  'BACKEND_HOST',
  'SUPERTOKEN_CONNECTION_URI',
  'TYPESENSE_HOST',
  'TYPESENSE_API_KEY',
];

function repoRoot(): string | undefined {
  let directory = __dirname;

  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      return directory;
    }
    directory = dirname(directory);
  }

  return undefined;
}

export function loadEnvironment(): void {
  const root = repoRoot();
  const candidates = [
    resolve(process.cwd(), '.env'),
    ...(root ? [join(root, '.env')] : []),
  ].filter((path, index, all) => all.indexOf(path) === index);

  const found = candidates.filter((path) => existsSync(path));

  if (found.length > 0) {
    expand(config({ path: found }));
  }

  const missing = REQUIRED.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    const source = found.length
      ? `the environment, or ${found.join(' and ')}`
      : `the environment; no .env was found at ${candidates.join(' or ')}`;

    throw new Error(
      `The server cannot start without ${missing.join(', ')}. ` +
        `It read ${source}. .env.example lists every variable.`,
    );
  }
}

loadEnvironment();
