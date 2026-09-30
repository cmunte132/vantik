/**
 * This file loads the environment before other modules read it.
 *
 * A value in process.env takes priority over a value in the file.
 * The server reads .env from the current directory and the repository root.
 * dotenv-expand resolves variables such as ${DB_HOST} in DATABASE_URL.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config } from 'dotenv';
import { expand } from 'dotenv-expand';

/**
 * The server needs these settings to start.
 * EMBEDDINGS_SOURCE is optional. If it is empty, search uses keywords only.
 * The value local uses a quantized MiniLM model on the server.
 * The value hosted uses an OpenAI-compatible endpoint.
 * EMBEDDINGS_MODEL selects the model or a local model directory.
 * EMBEDDINGS_BASE_URL and EMBEDDINGS_API_KEY configure the hosted endpoint.
 */
const REQUIRED = [
  'DATABASE_URL',
  'FRONTEND_HOST',
  'BACKEND_HOST',
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
