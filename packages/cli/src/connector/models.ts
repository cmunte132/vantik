/**
 * The models the person's own omp offers, read from omp itself so a run can
 * only ask for one that exists there.
 */
import type { ConnectorModel, ConnectorModels } from '@vantikhq/types';

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ompAgentDirPath } from './omp';

/** The levels omp's `--thinking` accepts. */
const LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
]);

/** How long omp gets to list its models. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

/** How often the connector looks again for a login or a new default. */
export const MODEL_REFRESH_MS = 10 * 60 * 1000;

/**
 * omp's `thinking` field is null, or an array of the levels the model takes
 * (for example `["low","medium","high","xhigh","max"]`). Anything else, or an
 * array with no known level, is "unknown".
 */
export function thinkingLevelsOf(thinking: unknown): string[] | null {
  if (!Array.isArray(thinking)) {
    return null;
  }
  const levels = thinking.filter(
    (level): level is string => typeof level === 'string' && LEVELS.has(level),
  );
  return levels.length > 0 ? levels : null;
}

/** The chat models of `omp models --json` output; other kinds are dropped. */
export function parseOmpModels(output: string): ConnectorModel[] {
  const parsed = JSON.parse(output) as { models?: unknown };
  if (!Array.isArray(parsed.models)) {
    return [];
  }

  const models: ConnectorModel[] = [];
  for (const entry of parsed.models as Record<string, unknown>[]) {
    if (
      !entry ||
      entry.kind !== 'chat' ||
      typeof entry.provider !== 'string' ||
      typeof entry.id !== 'string'
    ) {
      continue;
    }
    models.push({
      provider: entry.provider,
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      reasoning: entry.reasoning === true,
      thinkingLevels: thinkingLevelsOf(entry.thinking),
    });
  }
  return models;
}

/** `modelRoles.default` from `omp config get modelRoles` (JSON) output. */
export function parseDefaultFromRoles(output: string): string | null {
  try {
    const roles = JSON.parse(output) as { default?: unknown };
    return typeof roles?.default === 'string' && roles.default
      ? roles.default
      : null;
  } catch {
    return null;
  }
}

/**
 * `modelRoles: default: <selector>` from omp's `config.yml`. A line parse of
 * that one key: the connector has no YAML dependency.
 */
export function parseDefaultFromYaml(text: string): string | null {
  let inRoles = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^modelRoles:\s*(#.*)?$/.test(line)) {
      inRoles = true;
      continue;
    }
    if (!inRoles) {
      continue;
    }
    if (/^\S/.test(line)) {
      return null;
    }
    const match = /^\s+default:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/.exec(line);
    if (match) {
      return match[1] || match[2] || match[3] || null;
    }
  }
  return null;
}

/** Whether two discoveries differ, so `models` is sent only on a change. */
export function modelsChanged(
  previous: ConnectorModels | undefined,
  next: ConnectorModels,
): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'omp',
      args,
      { timeout: MODEL_DISCOVERY_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

async function discoverDefault(): Promise<string | null> {
  try {
    const found = parseDefaultFromRoles(
      await run(['config', 'get', 'modelRoles']),
    );
    if (found) {
      return found;
    }
  } catch {
    // Fall back to the file.
  }
  try {
    return parseDefaultFromYaml(
      readFileSync(path.join(ompAgentDirPath(), 'config.yml'), 'utf8'),
    );
  } catch {
    return null;
  }
}

/** Asks omp for its models and default. Throws when omp cannot list them. */
export async function discoverModels(): Promise<ConnectorModels> {
  const [listing, defaultModel] = await Promise.all([
    run(['models', '--json', '--no-extensions']),
    discoverDefault(),
  ]);
  return { models: parseOmpModels(listing), defaultModel };
}
