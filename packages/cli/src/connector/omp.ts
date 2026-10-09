/**
 * Finding omp on this machine and building the command that runs a Vantik run.
 */
import type { OmpChildLike } from './rpc';
import type { ConnectorRunDispatch } from '@vantikhq/types';

import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

type Env = Record<string, string | undefined>;

export interface OmpInstall {
  /** The version on the PATH, or null when omp is not installed. */
  version: string | null;
  /** Whether the omp agent directory exists. */
  agentDir: boolean;
}

/** `omp/18.8.6` or `omp v18.8.6` to `18.8.6`. */
export function parseOmpVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+[\w.+-]*)/.exec(output)?.[1] ?? null;
}

export function ompAgentDirPath(env: Env = process.env): string {
  return env.PI_CODING_AGENT_DIR || path.join(homedir(), '.omp', 'agent');
}

export function discoverOmp(env: Env = process.env): Promise<OmpInstall> {
  return new Promise((resolve) => {
    execFile('omp', ['--version'], { timeout: 15_000 }, (error, stdout) => {
      resolve({
        version: error ? null : parseOmpVersion(String(stdout)),
        agentDir: existsSync(ompAgentDirPath(env)),
      });
    });
  });
}

const THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
]);

/**
 * The omp arguments for a run.
 *
 * `--no-extensions` stops omp discovering the person's own extensions (one of
 * them may report to Vantik with their personal token) and the repository's;
 * the explicit `-e` still loads the Vantik extension. `--approval-mode yolo`
 * is the headless counterpart of the hosted sandbox: nobody is there to
 * approve, and the worktree is the boundary.
 */
export function ompArgs(
  dispatch: Pick<ConnectorRunDispatch, 'model' | 'resumeSessionId'>,
  extensionPath: string,
): string[] {
  const args = [
    '--mode',
    'rpc',
    '--approval-mode',
    'yolo',
    '--no-ui',
    '--no-title',
    '--no-extensions',
    '-e',
    extensionPath,
  ];

  // The caller has checked that no terminal holds this session.
  if (dispatch.resumeSessionId) {
    args.push('--resume', dispatch.resumeSessionId);
  }

  const { provider, model, thinking } = dispatch.model;
  if (model) {
    args.push('--model', provider ? `${provider}/${model}` : model);
  } else if (provider) {
    args.push('--provider', provider);
  }
  if (thinking && THINKING_LEVELS.has(thinking)) {
    args.push('--thinking', thinking);
  }
  return args;
}

/** Variables that carry the person's own Vantik credential. */
const PERSONAL_VANTIK_ENV = [
  'ACCESS_TOKEN',
  'BASE_HOST',
  'WORKSPACE_ID',
  'VANTIK_TOKEN',
  'VANTIK_URL',
  'VANTIK_API_URL',
  'VANTIK_POLICY',
  'VANTIK_CONFIG_DIR',
];

/**
 * The environment omp runs in: the person's own, without their Vantik
 * credential, plus the run token as the only one.
 *
 * `VANTIK_CONFIG_DIR` points the `vantik` CLI at an empty directory, so a
 * shell command in the run finds no stored login either.
 */
export function ompEnv(
  base: Env,
  run: {
    token: ConnectorRunDispatch['token'];
    policyPath: string;
    emptyConfigDir: string;
  },
): Env {
  const env: Env = { ...base };
  for (const name of PERSONAL_VANTIK_ENV) {
    delete env[name];
  }
  return {
    ...env,
    VANTIK_POLICY: run.policyPath,
    VANTIK_TOKEN: run.token.value,
    VANTIK_API_URL: run.token.apiUrl,
    VANTIK_URL: run.token.apiUrl,
    VANTIK_CONFIG_DIR: run.emptyConfigDir,
  };
}

export function spawnOmp(
  args: string[],
  options: { cwd: string; env: Env },
): OmpChildLike {
  return spawn('omp', args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as OmpChildLike;
}

/**
 * Reads the complete new lines of a file that another process appends to.
 * A partial last line waits for its newline.
 */
export class FileTail {
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);

  constructor(private readonly file: string) {}

  read(): string[] {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Truncated: start over.
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (size === this.offset) {
      return [];
    }

    const fd = openSync(this.file, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const read = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      let bytes = Buffer.concat([this.partial, buffer.subarray(0, read)]);
      const lines: string[] = [];
      let newline = bytes.indexOf(0x0a);
      while (newline >= 0) {
        lines.push(bytes.subarray(0, newline).toString('utf8'));
        bytes = bytes.subarray(newline + 1);
        newline = bytes.indexOf(0x0a);
      }
      this.partial = bytes;
      return lines.filter((line) => line.trim() !== '');
    } finally {
      closeSync(fd);
    }
  }
}
