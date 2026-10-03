import type { ContextPack } from '../context-pack.service';
import type { GuardrailPolicy } from './vantik-extension';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { verificationCommands } from '../agent-prompt';

/** Where the policy is seeded, relative to the guest's `/workspace`. */
export const POLICY_PATH = 'vantik-policy.json';

/** Where the agent's writes to Vantik queue up, relative to `/workspace`. */
export const OUTBOX_PATH = 'vantik-outbox.jsonl';

/** The context pack the host seeds, relative to `/workspace`. */
export const CONTEXT_PATH = 'context.json';

/**
 * The extension's files as they are on disk beside this one: the compiled
 * `.js` in a built server, the `.ts` source under ts-jest or a dev server. Pi
 * loads either, and the entry point's `./vantik-lsp` import resolves to the
 * sibling seeded in the same form.
 *
 * Read once. They are part of this build, not something that changes under it.
 */
const MODULES = ['vantik-extension', 'vantik-lsp'];

let cached: Array<{ name: string; source: string }> | undefined;

export function extensionSources(): Array<{ name: string; source: string }> {
  if (cached) {
    return cached;
  }

  for (const extension of ['.js', '.ts']) {
    const paths = MODULES.map((module) => join(__dirname, module + extension));
    if (paths.every((path) => existsSync(path))) {
      cached = paths.map((path, index) => ({
        name: MODULES[index] + extension,
        source: readFileSync(path, 'utf8'),
      }));
      return cached;
    }
  }

  throw new Error(
    `The Vantik Pi extension is missing from ${__dirname}; the server build is incomplete.`,
  );
}

/** What the extension is told about this run. */
export function guardrailPolicy(
  pack: ContextPack,
  egressHosts: string[] = [],
): GuardrailPolicy {
  return {
    repoRoot: '/workspace/repo',
    pathPrefixes: pack.repo?.pathPrefixes ?? [],
    checks: verificationCommands(pack).map(([, command]) => command),
    reachableHosts: ['registry.npmjs.org', ...egressHosts],
    contextPath: `/workspace/${CONTEXT_PATH}`,
    outboxPath: `/workspace/${OUTBOX_PATH}`,
  };
}

/** The files the extension needs in the guest, keyed by `/workspace` path. */
export function extensionFiles(
  pack: ContextPack,
  egressHosts: string[] = [],
): Record<string, string> {
  return {
    ...Object.fromEntries(
      extensionSources().map(({ name, source }) => [name, source]),
    ),
    [POLICY_PATH]: JSON.stringify(guardrailPolicy(pack, egressHosts), null, 2),
  };
}

/** The extension's absolute path in the guest, for `-e`. */
export function extensionGuestPath(): string {
  return `/workspace/${extensionSources()[0].name}`;
}
