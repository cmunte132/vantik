/**
 * Seeds a run's directory: the files the Vantik extension and the first prompt
 * need, outside the worktree so they never land in the person's commits.
 */
import type { ConnectorRunDispatch } from '@vantikhq/types';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface SeededRun {
  runDir: string;
  policyPath: string;
  contextPath: string;
  outboxPath: string;
  promptPath: string;
  /** An empty directory, used as the run's Vantik CLI config directory. */
  emptyConfigDir: string;
}

/** The policy file the extension reads, with paths on this machine. */
export function buildPolicy(
  dispatch: Pick<ConnectorRunDispatch, 'policy'>,
  paths: { repoRoot: string; contextPath: string; outboxPath: string },
) {
  const { policy } = dispatch;
  return {
    repoRoot: paths.repoRoot,
    pathPrefixes: policy.pathPrefixes.map(String),
    checks: Array.isArray(policy.checks) ? policy.checks.map(String) : [],
    reachableHosts: policy.reachableHosts.map(String),
    contextPath: paths.contextPath,
    outboxPath: paths.outboxPath,
    ...(typeof policy.maxOutputTokens === 'number'
      ? { maxOutputTokens: policy.maxOutputTokens }
      : {}),
  };
}

export function seedRunDir(
  runDir: string,
  worktreePath: string,
  dispatch: ConnectorRunDispatch,
): SeededRun {
  const seeded: SeededRun = {
    runDir,
    policyPath: path.join(runDir, 'vantik-policy.json'),
    contextPath: path.join(runDir, 'context.json'),
    outboxPath: path.join(runDir, 'vantik-outbox.jsonl'),
    promptPath: path.join(runDir, 'prompt.md'),
    emptyConfigDir: path.join(runDir, 'vantik-config'),
  };

  mkdirSync(runDir, { recursive: true });
  mkdirSync(seeded.emptyConfigDir, { recursive: true });

  writeFileSync(
    seeded.policyPath,
    JSON.stringify(
      buildPolicy(dispatch, {
        repoRoot: worktreePath,
        contextPath: seeded.contextPath,
        outboxPath: seeded.outboxPath,
      }),
      null,
      2,
    ),
  );
  writeFileSync(
    seeded.contextPath,
    JSON.stringify(dispatch.context ?? {}, null, 2),
  );
  // A fresh outbox. A rerun of the same run id starts from nothing.
  writeFileSync(seeded.outboxPath, '');
  writeFileSync(seeded.promptPath, dispatch.prompt);

  return seeded;
}

/** Marks the `vantik` server entry as one the connector wrote, and for which run. */
const MARKER = 'x-vantik-run';

/** The omp MCP server entry for the run's Vantik MCP endpoint, shaped like a person's own. */
export function vantikMcpEntry(token: ConnectorRunDispatch['token']) {
  return {
    type: 'http',
    url: `${token.apiUrl.replace(/\/+$/, '')}/v1/mcp`,
    headers: { Authorization: `Bearer ${token.value}` },
  };
}

/**
 * Writes `<worktree>/.omp/mcp.json` with a `vantik` server on the run's token.
 *
 * omp reads the project file before the person's user-level file and ranks its
 * own config above every other source (Claude, Cursor and the rest), and the
 * first server of a name wins. So the person's own `vantik` server, with their
 * own token, is replaced for this run. Other servers are left as they are.
 *
 * A file the repository already has is merged and put back by `restore`.
 * Returns that `restore`.
 */
export function installMcpOverride(
  worktreePath: string,
  token: ConnectorRunDispatch['token'],
  runId: string,
): () => void {
  const dir = path.join(worktreePath, '.omp');
  const file = path.join(dir, 'mcp.json');
  const dirExisted = existsSync(dir);
  let prior = existsSync(file) ? readFileSync(file, 'utf8') : null;

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (prior) {
    try {
      const parsed = JSON.parse(prior) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as typeof config;
      }
    } catch {
      // Unreadable: omp could not use it either.
    }

    // An override a crashed run left behind is ours, not the repository's:
    // take it out, so it is never put back as the "prior" file.
    const stale = config.mcpServers?.vantik as
      Record<string, unknown> | undefined;
    if (stale && typeof stale === 'object' && MARKER in stale) {
      const others = Object.fromEntries(
        Object.entries(config.mcpServers ?? {}).filter(
          ([name]) => name !== 'vantik',
        ),
      );
      config = { ...config, mcpServers: others };
      const rest = { ...config } as Record<string, unknown>;
      if (Object.keys(others).length === 0) {
        delete rest.mcpServers;
      }
      prior =
        Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        ...config,
        mcpServers: {
          ...config.mcpServers,
          vantik: { ...vantikMcpEntry(token), [MARKER]: runId },
        },
      },
      null,
      2,
    ),
  );

  return () => {
    if (prior !== null) {
      writeFileSync(file, prior);
      return;
    }
    rmSync(file, { force: true });
    if (!dirExisted) {
      try {
        rmdirSync(dir);
      } catch {
        // omp put something else in it.
      }
    }
  };
}
