import type { ContextPack } from '../context-pack.service';
import type { GuardrailPolicy } from './vantik-extension';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { verificationCommands } from '../agent-prompt';

/** Where the policy is seeded, relative to the guest's `/workspace`. */
export const POLICY_PATH = 'vantik-policy.json';

/**
 * The extension as it is on disk beside this file: the compiled `.js` in a
 * built server, the `.ts` source under ts-jest or a dev server. Pi loads
 * either, so the guest file keeps the extension it was read with.
 *
 * Read once. It is part of this build, not something that changes under it.
 */
let cached: { name: string; source: string } | undefined;

export function extensionFile(): { name: string; source: string } {
  if (cached) {
    return cached;
  }

  for (const name of ['vantik-extension.js', 'vantik-extension.ts']) {
    const path = join(__dirname, name);
    if (existsSync(path)) {
      cached = { name, source: readFileSync(path, 'utf8') };
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
  };
}

/** The files the extension needs in the guest, keyed by `/workspace` path. */
export function extensionFiles(
  pack: ContextPack,
  egressHosts: string[] = [],
): Record<string, string> {
  const { name, source } = extensionFile();

  return {
    [name]: source,
    [POLICY_PATH]: JSON.stringify(guardrailPolicy(pack, egressHosts), null, 2),
  };
}

/** The extension's absolute path in the guest, for `-e`. */
export function extensionGuestPath(): string {
  return `/workspace/${extensionFile().name}`;
}
