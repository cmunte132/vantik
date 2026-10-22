/**
 * The official Claude Code CLI as an external agent for omp.
 *
 * The `claude_delegate` tool runs the unmodified `claude` binary, signed in
 * with the user's own Claude subscription, and reports what it did. Nothing
 * here reads or copies credentials. The CLI keeps its login where it always
 * does; this file only asks it, through `claude auth status`, whether that
 * login is a claude.ai subscription, and refuses to run otherwise.
 *
 * Most of it is pure, so the rules are tested without a Claude install: the
 * environment, the arguments, how a run is judged, what it costs, and the
 * per-session checkpoints. The process runner is the one piece that touches
 * the machine; its tests drive it with a fake CLI.
 *
 * Imports Node's built-ins only, so the bundled extension needs nothing else.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MAX_TURNS = 200;
export const MAX_PROMPT_CHARS = 100_000;

/** Set in the child's environment so a delegated run cannot start another. */
export const CHILD_MARKER = 'VANTIK_CLAUDE_DELEGATE_CHILD';

export const INTENTS = ['execution', 'reasoning', 'review'] as const;
export const TOOL_PROFILES = ['none', 'read', 'edit'] as const;
export type Intent = (typeof INTENTS)[number];
export type ToolProfile = (typeof TOOL_PROFILES)[number];

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const TOOLS_BY_PROFILE: Record<ToolProfile, string[]> = {
  none: [],
  read: READ_TOOLS,
  edit: [...READ_TOOLS, 'Edit', 'Write'],
};

/** The MCP configuration the child gets: explicitly no servers. */
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

const AUTH_TIMEOUT_MS = 30_000;
const AUTH_MAX_OUTPUT_BYTES = 64 * 1024;
const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 4_000;
const MAX_MESSAGE_CHARS = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite, non-negative dollar amount, or null when it is not one. */
const usd = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;

const roundUsd = (value: number) => Math.round(value * 1e10) / 1e10;

// ------------------------------------------------------------- environment

const STRIPPED_NAMES: Record<string, true> = {
  CLAUDE_CODE_OAUTH_TOKEN: true,
  ACCESS_TOKEN: true,
};

/** Other providers and the host's own settings: none of them reach the child. */
const STRIPPED_PREFIXES = ['ANTHROPIC_', 'VANTIK_', 'CLAUDE_CODE_USE_'];

/**
 * The environment the child runs in: the parent's, minus every variable that
 * would send the run to an API key, another provider, or a custom endpoint.
 * HOME, PATH and CLAUDE_CONFIG_DIR stay, because the native login lives there.
 */
export function sanitizeEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || STRIPPED_NAMES[name] === true) {
      continue;
    }
    if (STRIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    env[name] = value;
  }
  env[CHILD_MARKER] = '1';
  return env;
}

// --------------------------------------------------------------- arguments

/**
 * The `claude` arguments for one run. The prompt is not here: it goes on
 * stdin, so it never shows in the process list. No permission bypass, no bare
 * mode, no fallback model, and no MCP servers.
 */
export function buildArgs(options: {
  model: string;
  toolProfile: ToolProfile;
  /** Continue this native session. */
  resumeSessionId?: string;
  /** Start a native session with this id, planned for the tool call. */
  newSessionId?: string;
  maxTurns?: number;
}): string[] {
  const tools = TOOLS_BY_PROFILE[options.toolProfile];
  return [
    '--print',
    '--output-format',
    'json',
    '--model',
    options.model,
    '--tools',
    tools.join(','),
    ...(tools.length ? ['--allowedTools', tools.join(',')] : []),
    '--safe-mode',
    '--restricted',
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP_CONFIG,
    ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : []),
    ...(options.newSessionId ? ['--session-id', options.newSessionId] : []),
    ...(options.maxTurns ? ['--max-turns', String(options.maxTurns)] : []),
  ];
}

/**
 * The native session a new delegation asks for: a version-5 UUID derived from
 * the OMP session and the tool call. The same call always names the same
 * session, so a repeat of it meets the same checkpoint and the same native
 * session lock, and nothing random can split the two.
 */
export function plannedSessionId(
  ompSessionId: string | null,
  invocationId: string,
): string {
  const digest = createHash('sha256')
    .update(`claude-delegate\0${ompSessionId ?? ''}\0${invocationId}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

// --------------------------------------------------------- process runner

export type Stop = 'timeout' | 'cancelled' | 'output-limit';
export type Reason = 'exit' | 'spawn-error' | Stop;

export interface RunOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
}

export interface ProcessOutcome {
  reason: Reason;
  /** False when the process may still be alive after the escalation bound. */
  reaped: boolean;
  spawnError: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with an argument array and no shell. The child leads its own
 * process group on Unix, so a stop signals the whole tree: SIGTERM first, then
 * SIGKILL after a grace period, and the wait is bounded so a stop can never
 * hang. Output past the byte limit stops the run rather than being cut short.
 */
export function runProcess(options: RunOptions): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        reason: 'cancelled',
        reaped: true,
        spawnError: null,
        exitCode: null,
        exitSignal: null,
        stdout: '',
        stderr: '',
      });
      return;
    }

    const maxStdout = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let stopReason: Stop | null = null;
    let spawnError: string | null = null;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let settled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    let child: ChildProcess;
    try {
      child = spawn(options.binary, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        reason: 'spawn-error',
        reaped: true,
        spawnError: errorText(error),
        exitCode: null,
        exitSignal: null,
        stdout: '',
        stderr: '',
      });
      return;
    }

    const later = (ms: number, action: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        action();
      }, ms);
      timers.add(timer);
    };

    const clearTimers = () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    };

    const finish = (reaped: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        reason: spawnError !== null ? 'spawn-error' : (stopReason ?? 'exit'),
        reaped,
        spawnError,
        exitCode,
        exitSignal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr,
      });
    };

    const signalTree = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) {
        return;
      }
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else {
          process.kill(-pid, signal);
        }
      } catch {
        // The group is already gone.
      }
    };

    const stop = (reason: Stop) => {
      if (stopReason !== null || settled) {
        return;
      }
      stopReason = reason;
      signalTree('SIGTERM');
      later(TERM_GRACE_MS, () => signalTree('SIGKILL'));
      later(TERM_GRACE_MS + KILL_GRACE_MS, () => finish(false));
    };

    const onAbort = () => stop('cancelled');

    child.on('error', (error) => {
      // Before a pid exists the program never started (for example ENOENT).
      if (child.pid === undefined) {
        spawnError = errorText(error);
        finish(true);
      }
    });

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (stopReason !== null) {
        // The leader is gone; anything it left in the group goes too.
        signalTree('SIGKILL');
        finish(true);
      }
    });

    child.on('close', () => finish(true));

    child.stdin?.on('error', () => {
      // The CLI may exit before it reads the prompt; the exit code says why.
    });
    child.stdin?.end(options.input);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stopReason !== null) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        stop('output-limit');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk
          .toString('utf8')
          .slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });

    options.signal?.addEventListener('abort', onAbort, { once: true });
    later(options.timeoutMs, () => stop('timeout'));
  });
}

function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

/** Text that may reach a message or a log, with credentials and emails cut out. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[\w-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '[redacted]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[redacted]')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

// -------------------------------------------------------------------- auth

export type AuthCheck =
  | { ok: true; authMethod: 'claude.ai'; plan: string | null }
  | { ok: false; message: string };

/**
 * Asks the official CLI whether it is signed in with a claude.ai subscription
 * on the first-party API. Runs under the same sanitized environment as a
 * delegation, and does no inference. Anything other than a clear yes fails.
 */
export async function checkAuth(
  options: { binary: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  cwd: string,
): Promise<AuthCheck> {
  const outcome = await runProcess({
    binary: options.binary,
    args: ['auth', 'status'],
    cwd,
    env: sanitizeEnv(options.env),
    input: '',
    timeoutMs: AUTH_TIMEOUT_MS,
    maxStdoutBytes: AUTH_MAX_OUTPUT_BYTES,
    signal: options.signal,
  });

  if (outcome.reason !== 'exit') {
    return {
      ok: false,
      message: `claude auth status did not finish (${outcome.reason}). Run the claude CLI and check your login.`,
    };
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      message: `claude auth status exited with code ${outcome.exitCode ?? outcome.exitSignal}. Check your login.`,
    };
  }

  let status: unknown;
  try {
    status = JSON.parse(outcome.stdout);
  } catch {
    return {
      ok: false,
      message:
        'claude auth status printed something other than its JSON status.',
    };
  }
  if (!isRecord(status) || status.loggedIn !== true) {
    return {
      ok: false,
      message:
        'Claude is not logged in. Run the claude CLI and sign in with your Claude subscription.',
    };
  }
  if (status.authMethod !== 'claude.ai') {
    return {
      ok: false,
      message:
        'Claude is signed in with a method other than a claude.ai subscription, so this run would not be on the subscription. Sign in with claude.ai.',
    };
  }
  if (status.apiProvider !== 'firstParty') {
    return {
      ok: false,
      message:
        'Claude is routed to a provider other than Anthropic first-party. Unset the provider variables and sign in with claude.ai.',
    };
  }

  return {
    ok: true,
    authMethod: 'claude.ai',
    plan:
      typeof status.subscriptionType === 'string'
        ? status.subscriptionType
        : null,
  };
}

/** One line for a person: the method and plan, never the account. */
export function describeAuth(auth: AuthCheck): string {
  return auth.ok === true
    ? `Claude login: claude.ai subscription (plan: ${auth.plan ?? 'unknown'}).`
    : `Claude login: not ready. ${auth.message}`;
}

// ------------------------------------------------------------------ results

/**
 * The result object that `claude -p --output-format json` prints, or null when
 * the output is anything else. Only that one object is requested, so nothing
 * else is read.
 */
export function parseResultJson(
  stdout: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  return isRecord(parsed) && parsed.type === 'result' ? parsed : null;
}

export type ErrorKind =
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'cancelled'
  | 'output-limit'
  | 'spawn'
  | 'exit'
  | 'claude-error'
  | 'bad-output'
  | 'session-mismatch'
  | 'unknown-baseline'
  | 'duplicate'
  | 'session-conflict'
  | 'busy'
  | 'checkpoint'
  | 'recursion'
  | 'input';

export interface DelegateError {
  kind: ErrorKind;
  message: string;
}

const AUTH_TEXT =
  /revoked|not logged in|please run \/login|invalid (?:api key|authentication|bearer)|authentication_error|oauth/i;
const QUOTA_TEXT = /usage limit|rate limit|quota|credit balance|limit reached/i;

/**
 * Why a result message is not a success, or null when it is one. Only
 * `is_error: false` with a `success` subtype, a completed terminal reason and
 * no API error status counts. A `success` subtype alone does not: a rejected
 * login can arrive as `success`.
 */
export function resultFailure(
  result: Record<string, unknown>,
): DelegateError | null {
  const status =
    typeof result.api_error_status === 'number'
      ? result.api_error_status
      : null;
  const reason =
    typeof result.terminal_reason === 'string' ? result.terminal_reason : null;
  const text = typeof result.result === 'string' ? result.result : '';

  const unsuccessful =
    result.is_error !== false ||
    result.subtype !== 'success' ||
    (reason !== null && reason !== 'completed') ||
    (status !== null && status >= 400);
  if (!unsuccessful) {
    return null;
  }

  if (status === 401 || status === 403 || AUTH_TEXT.test(text)) {
    return {
      kind: 'auth',
      message: `Claude refused this run's login (${status ?? 'no status'}). Nothing was retried or moved to another account. Sign in again with the official claude CLI.`,
    };
  }
  if (status === 402 || status === 429 || QUOTA_TEXT.test(text)) {
    return {
      kind: 'quota',
      message:
        "Claude's subscription limit stopped this run. Nothing was retried or sent to another model.",
    };
  }
  return {
    kind: 'claude-error',
    message: `Claude finished with an error (${reason ?? String(result.subtype ?? 'unknown')}): ${redact(text) || 'no message'}`,
  };
}

/** Whether a finished process, and its result, is a completed run. */
export function judgeRun(
  outcome: ProcessOutcome,
  result: Record<string, unknown> | null,
  timeoutMs: number,
): { status: DelegateStatus; error: DelegateError | null } {
  const failed = (kind: ErrorKind, message: string) => ({
    status: 'failed' as const,
    error: { kind, message },
  });
  const notConfirmed = outcome.reaped
    ? ''
    : ' The claude process did not confirm exit; check for a running claude process.';

  if (outcome.reason === 'cancelled') {
    return {
      status: 'cancelled',
      error: {
        kind: 'cancelled',
        message: `Stopped before Claude finished.${notConfirmed}`,
      },
    };
  }
  if (outcome.reason === 'timeout') {
    return failed(
      'timeout',
      `Claude did not finish within ${timeoutMs} ms and was stopped.${notConfirmed}`,
    );
  }
  if (outcome.reason === 'output-limit') {
    return failed(
      'output-limit',
      `Claude wrote more output than the adapter reads, so the run was stopped and its result cannot be read safely.${notConfirmed}`,
    );
  }
  if (outcome.reason === 'spawn-error') {
    return failed(
      'spawn',
      `The claude CLI could not be started (${outcome.spawnError ?? 'unknown error'}). Install Claude Code and check PATH.`,
    );
  }

  const stderr = redact(outcome.stderr).slice(0, 500);
  const failure = result ? resultFailure(result) : null;

  if (outcome.exitCode !== 0) {
    return failure
      ? failed(failure.kind, failure.message)
      : failed(
          'exit',
          `claude exited with code ${outcome.exitCode ?? outcome.exitSignal}.${stderr ? ` stderr: ${stderr}` : ''}`,
        );
  }
  if (!result) {
    return failed(
      'bad-output',
      `claude did not print the single result object that --output-format json produces.${stderr ? ` stderr: ${stderr}` : ''}`,
    );
  }
  if (failure) {
    return failed(failure.kind, failure.message);
  }
  return { status: 'completed', error: null };
}

// --------------------------------------------------------------- checkpoints

export interface Checkpoint {
  v: 1;
  claudeSessionId: string;
  /** The OMP session that last ran this Claude session. Provenance only. */
  ompSessionId: string | null;
  /** The native session's cumulative API-equivalent total as last seen. */
  cumulativeApiEquivalentUsd: number;
  invocations: Array<{
    invocationId: string;
    ompSessionId: string | null;
    cumulativeApiEquivalentUsd: number;
    deltaApiEquivalentUsd: number | null;
  }>;
  updatedAt: string;
}

/**
 * Turns a native cumulative total into this invocation's spend.
 *
 * A new session starts at zero, so its delta is its total. A resumed one
 * subtracts the checkpoint's baseline, never the whole conversation. A total
 * that falls below the baseline means the counter was reset, so the delta is
 * unknown and the new total becomes the baseline; spend is never negative. An
 * invocation already recorded returns its stored delta and changes nothing.
 */
export function recordCheckpoint(
  previous: Checkpoint | null,
  input: {
    claudeSessionId: string;
    ompSessionId: string | null;
    invocationId: string;
    cumulativeUsd: number;
    now: string;
  },
): { checkpoint: Checkpoint; deltaUsd: number | null; counterReset: boolean } {
  const seen = previous?.invocations.find(
    (entry) => entry.invocationId === input.invocationId,
  );
  if (previous && seen) {
    return {
      checkpoint: previous,
      deltaUsd: seen.deltaApiEquivalentUsd,
      counterReset: false,
    };
  }

  const baseline = previous?.cumulativeApiEquivalentUsd ?? 0;
  const counterReset = previous !== null && input.cumulativeUsd < baseline;
  const deltaUsd =
    previous === null
      ? input.cumulativeUsd
      : counterReset
        ? null
        : roundUsd(input.cumulativeUsd - baseline);

  // Every invocation is kept for the session's lifetime: dropping an old one
  // would let a repeat of it run again.
  const invocations = [
    ...(previous?.invocations ?? []),
    {
      invocationId: input.invocationId,
      ompSessionId: input.ompSessionId,
      cumulativeApiEquivalentUsd: input.cumulativeUsd,
      deltaApiEquivalentUsd: deltaUsd,
    },
  ];

  return {
    checkpoint: {
      v: 1,
      claudeSessionId: input.claudeSessionId,
      ompSessionId: input.ompSessionId ?? previous?.ompSessionId ?? null,
      cumulativeApiEquivalentUsd: input.cumulativeUsd,
      invocations,
      updatedAt: input.now,
    },
    deltaUsd,
    counterReset,
  };
}

function isCheckpoint(value: unknown): value is Checkpoint {
  return (
    isRecord(value) &&
    value.v === 1 &&
    typeof value.claudeSessionId === 'string' &&
    usd(value.cumulativeApiEquivalentUsd) !== null &&
    Array.isArray(value.invocations)
  );
}

export interface CheckpointStore {
  /** The checkpoint, or null when there is none or it cannot be read. */
  read(claudeSessionId: string): Checkpoint | null;
  write(checkpoint: Checkpoint): void;
  /**
   * Takes the session's lock, or returns null when a lock file already exists.
   * The owner releases it; a leftover is never removed automatically.
   */
  lock(claudeSessionId: string): (() => void) | null;
}

/**
 * Per-session checkpoints and locks under `dir`, one file each, named by the
 * hash of the session id. They hold ids, totals and times only: no prompt, no
 * result, no credential.
 */
export function createCheckpointStore(dir: string): CheckpointStore {
  const fileFor = (
    kind: 'sessions' | 'locks',
    sessionId: string,
    ext: string,
  ) =>
    join(
      dir,
      kind,
      `${createHash('sha256').update(sessionId).digest('hex')}${ext}`,
    );

  return {
    read(sessionId) {
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(fileFor('sessions', sessionId, '.json'), 'utf8'),
        );
        return isCheckpoint(parsed) && parsed.claudeSessionId === sessionId
          ? parsed
          : null;
      } catch {
        return null;
      }
    },

    write(checkpoint) {
      const file = fileFor('sessions', checkpoint.claudeSessionId, '.json');
      const temp = `${file}.${randomUUID()}.tmp`;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, {
          mode: 0o600,
        });
        renameSync(temp, file);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },

    lock(sessionId) {
      const file = fileFor('locks', sessionId, '.lock');
      const token = randomUUID();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

      try {
        // 'wx' creates the file or fails: that is the atomic part. An existing
        // lock is never removed here, even when its owner looks gone. Two
        // contenders could both judge it stale, and the second removal would
        // delete the first one's live lock. A leftover is cleared by hand.
        writeFileSync(file, JSON.stringify({ token, pid: process.pid }), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (isErrnoCode(error, 'EEXIST')) {
          return null;
        }
        throw error;
      }

      return () => {
        if (lockToken(file) === token) {
          rmSync(file, { force: true });
        }
      };
    },
  };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function lockToken(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      token?: unknown;
    };
    return typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------- delegate

export interface DelegateRequest {
  prompt: string;
  intent: Intent;
  cwd: string;
  toolProfile?: ToolProfile;
  model?: string;
  resumeSessionId?: string;
  timeoutMs?: number;
  maxTurns?: number;
  /** The tool call's id: stable across a replay of the same call. */
  invocationId: string;
  ompSessionId: string | null;
  signal?: AbortSignal;
}

export type DelegateStatus = 'completed' | 'failed' | 'cancelled';

export interface Billing {
  mode: 'subscription';
  /** Claude's `total_cost_usd` is API list price: it is not cash or quota. */
  costBasis: 'list';
  /** The native total as reported, or null when it was not reported. */
  apiEquivalentUsd: number | null;
  /** This invocation's share of the native total, or null when unknown. */
  deltaApiEquivalentUsd: number | null;
  cumulative: true;
  counterReset?: true;
}

/**
 * What the tool reports back. `kind`, `version`, `invocationId` and `billing`
 * are the contract the Vantik ingestion reads, so keep their names and shapes.
 */
export interface DelegateDetails {
  kind: 'claude-delegate';
  version: 1;
  invocationId: string;
  ompSessionId: string | null;
  claudeSessionId: string | null;
  intent: Intent;
  requestedModel: string;
  modelSelection: 'explicit' | 'default';
  /** The models Claude says it used, from the keys of `modelUsage`. */
  actualModels: string[];
  toolProfile: ToolProfile;
  cwd: string;
  status: DelegateStatus;
  error: DelegateError | null;
  result: string | null;
  /** Claude's `modelUsage`, verbatim. */
  modelUsage: Record<string, unknown> | null;
  /** Claude's `usage`, verbatim. */
  usage: unknown;
  numTurns: number | null;
  permissionDenials: unknown[] | null;
  resumed: boolean;
  billing: Billing;
}

export interface DelegateDeps {
  binary: string;
  /** The parent's environment, which is sanitized before the child sees it. */
  env: NodeJS.ProcessEnv;
  store: CheckpointStore;
  now(): string;
}

/**
 * Checks and runs one delegation: the recursion guard, the working directory,
 * then the native session's lock and checkpoint, the login, and the run.
 *
 * A new call names its native session from the tool call (`plannedSessionId`),
 * and a resume names its own. Either way the lock is taken first, and a tool
 * call already recorded in that session is refused as `duplicate` before the
 * login is checked or Claude is started. A new call that finds a checkpoint it
 * did not write is refused as `session-conflict`, so a native conversation is
 * never reset. Every outcome comes back as details. Never retries and never
 * falls back to another model.
 */
export async function delegate(
  request: DelegateRequest,
  deps: DelegateDeps,
): Promise<DelegateDetails> {
  const details = startDetails(request);
  const fail = (kind: ErrorKind, message: string): DelegateDetails => {
    details.status = 'failed';
    details.error = { kind, message };
    return details;
  };

  if (deps.env[CHILD_MARKER] === '1') {
    return fail(
      'recursion',
      'This run is already inside a delegated Claude run, so it will not start another.',
    );
  }
  if (!isDirectory(request.cwd)) {
    return fail('input', `${request.cwd} is not a directory.`);
  }

  const resuming = request.resumeSessionId !== undefined;
  const sessionId =
    request.resumeSessionId ??
    plannedSessionId(request.ompSessionId, request.invocationId);
  details.claudeSessionId = sessionId;

  // One lock for both kinds of call, taken before anything is read or run, so
  // two calls for the same session, or two for the same tool call, cannot both
  // reach Claude.
  const release = deps.store.lock(sessionId);
  if (!release) {
    return fail(
      'busy',
      'Another run holds this Claude session, or a lock left by a run that did not finish is in place. Wait for the run to finish. If no claude process is running for this session, remove its lock file (locks/<sha256 of the session id>.lock under the claude-delegation directory) by hand; the adapter never removes a lock it did not take.',
    );
  }

  try {
    const previous = deps.store.read(sessionId);
    if (resuming && !previous) {
      return fail(
        'unknown-baseline',
        'This Claude session has no spend checkpoint on this machine, so its cost cannot be attributed. Start a new session instead.',
      );
    }
    if (previous) {
      // Refused before any login check or inference: a repeat of a finished
      // call must not spend again, and its spend is already booked.
      if (
        previous.invocations.some(
          (entry) => entry.invocationId === request.invocationId,
        )
      ) {
        details.status = 'failed';
        details.error = {
          kind: 'duplicate',
          message: `This tool call already completed in Claude session ${sessionId}, and its spend is recorded there. Nothing was run again. Resume that session with resumeSessionId to do more work.`,
        };
        return details;
      }
      if (!resuming) {
        return fail(
          'session-conflict',
          `Claude session ${sessionId} already has a checkpoint for another tool call. Nothing was run, so that conversation was not reset.`,
        );
      }
    }

    const auth = await checkAuth(
      { binary: deps.binary, env: deps.env, signal: request.signal },
      request.cwd,
    );
    if (auth.ok === false) {
      if (request.signal?.aborted) {
        details.status = 'cancelled';
        details.error = {
          kind: 'cancelled',
          message: 'Stopped before Claude started.',
        };
        return details;
      }
      return fail('auth', auth.message);
    }

    const outcome = await runProcess({
      binary: deps.binary,
      args: buildArgs({
        model: details.requestedModel,
        toolProfile: details.toolProfile,
        resumeSessionId: request.resumeSessionId,
        newSessionId: resuming ? undefined : sessionId,
        maxTurns: request.maxTurns,
      }),
      cwd: request.cwd,
      env: sanitizeEnv(deps.env),
      input: request.prompt,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: request.signal,
    });

    return settle(details, request, outcome, previous, deps, sessionId);
  } finally {
    release();
  }
}

function settle(
  details: DelegateDetails,
  request: DelegateRequest,
  outcome: ProcessOutcome,
  previous: Checkpoint | null,
  deps: DelegateDeps,
  expectedSession: string,
): DelegateDetails {
  const result =
    outcome.reason === 'exit' ? parseResultJson(outcome.stdout) : null;
  const judged = judgeRun(
    outcome,
    result,
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  details.status = judged.status;
  details.error = judged.error;

  if (result) {
    details.result = typeof result.result === 'string' ? result.result : null;
    details.modelUsage = isRecord(result.modelUsage) ? result.modelUsage : null;
    details.actualModels = details.modelUsage
      ? Object.keys(details.modelUsage)
      : [];
    details.usage = result.usage ?? null;
    details.numTurns =
      typeof result.num_turns === 'number' ? result.num_turns : null;
    details.permissionDenials = Array.isArray(result.permission_denials)
      ? result.permission_denials
      : null;
  }

  const sessionId =
    typeof result?.session_id === 'string' ? result.session_id : null;
  if (sessionId) {
    details.claudeSessionId = sessionId;
  }

  // The native session must be the one this call asked for. A resume that came
  // back as another session is not the one we hold a baseline for, and a new
  // call that came back under another id is not the one we planned, so in both
  // cases the total is shown but never booked.
  const mismatch = result !== null && sessionId !== expectedSession;
  if (mismatch && details.status === 'completed') {
    details.status = 'failed';
    details.error = {
      kind: 'session-mismatch',
      message: `Claude answered in session ${sessionId ?? 'none'}, not ${expectedSession}. Its spend is shown but not booked.`,
    };
  }

  const total = result ? usd(result.total_cost_usd) : null;
  details.billing.apiEquivalentUsd = total;
  if (total === null || mismatch) {
    return details;
  }

  try {
    if (!sessionId) {
      throw new Error('Claude did not name its session');
    }
    const recorded = recordCheckpoint(previous, {
      claudeSessionId: sessionId,
      ompSessionId: request.ompSessionId,
      invocationId: request.invocationId,
      cumulativeUsd: total,
      now: deps.now(),
    });
    deps.store.write(recorded.checkpoint);
    details.billing.deltaApiEquivalentUsd = recorded.deltaUsd;
    if (recorded.counterReset) {
      details.billing.counterReset = true;
    }
  } catch (error) {
    details.billing.deltaApiEquivalentUsd = null;
    details.status = 'failed';
    details.error = details.error ?? {
      kind: 'checkpoint',
      message: `Claude reported its spend, but it was not saved (${errorText(error)}). The amount is in billing.apiEquivalentUsd.`,
    };
  }
  return details;
}

function startDetails(request: DelegateRequest): DelegateDetails {
  return {
    kind: 'claude-delegate',
    version: 1,
    invocationId: request.invocationId,
    ompSessionId: request.ompSessionId,
    claudeSessionId: request.resumeSessionId ?? null,
    intent: request.intent,
    requestedModel: request.model ?? DEFAULT_MODEL,
    modelSelection: request.model ? 'explicit' : 'default',
    actualModels: [],
    toolProfile: request.toolProfile ?? 'read',
    cwd: request.cwd,
    status: 'failed',
    error: null,
    result: null,
    modelUsage: null,
    usage: null,
    numTurns: null,
    permissionDenials: null,
    resumed: request.resumeSessionId !== undefined,
    billing: {
      mode: 'subscription',
      costBasis: 'list',
      apiEquivalentUsd: null,
      deltaApiEquivalentUsd: null,
      cumulative: true,
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- parameters

export type DelegateParams = Pick<
  DelegateRequest,
  | 'prompt'
  | 'intent'
  | 'cwd'
  | 'toolProfile'
  | 'model'
  | 'resumeSessionId'
  | 'timeoutMs'
  | 'maxTurns'
>;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;

/**
 * The tool's parameters, checked. Throws a message that tells the agent what
 * to fix. A relative `cwd` is refused; the default is the run's own directory.
 */
export function parseDelegateParams(
  params: Record<string, unknown>,
  defaultCwd: string,
): DelegateParams {
  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
  if (!prompt) {
    throw new Error('prompt is required: the task for Claude, in full.');
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `prompt is over ${MAX_PROMPT_CHARS} characters. Send less.`,
    );
  }

  const intent = params.intent;
  if (!INTENTS.includes(intent as Intent)) {
    throw new Error(`intent must be one of ${INTENTS.join(', ')}.`);
  }

  const cwd = params.cwd ?? defaultCwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('cwd must be an absolute directory path.');
  }

  const toolProfile = params.toolProfile ?? 'read';
  if (!TOOL_PROFILES.includes(toolProfile as ToolProfile)) {
    throw new Error(`toolProfile must be one of ${TOOL_PROFILES.join(', ')}.`);
  }

  const model = params.model;
  if (
    model !== undefined &&
    !(typeof model === 'string' && MODEL_ID.test(model))
  ) {
    throw new Error(
      'model must be a Claude model id such as claude-haiku-5-5.',
    );
  }

  const resumeSessionId = params.resumeSessionId;
  if (
    resumeSessionId !== undefined &&
    !(typeof resumeSessionId === 'string' && SESSION_ID.test(resumeSessionId))
  ) {
    throw new Error(
      'resumeSessionId must be the session id from an earlier result.',
    );
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}.`,
    );
  }

  const maxTurns = params.maxTurns;
  if (
    maxTurns !== undefined &&
    !(
      typeof maxTurns === 'number' &&
      Number.isInteger(maxTurns) &&
      maxTurns >= 1 &&
      maxTurns <= MAX_TURNS
    )
  ) {
    throw new Error(`maxTurns must be a whole number from 1 to ${MAX_TURNS}.`);
  }

  return {
    prompt,
    intent: intent as Intent,
    cwd,
    toolProfile: toolProfile as ToolProfile,
    timeoutMs,
    ...(typeof params.model === 'string' ? { model: params.model } : {}),
    ...(typeof params.resumeSessionId === 'string'
      ? { resumeSessionId: params.resumeSessionId }
      : {}),
    ...(typeof maxTurns === 'number' ? { maxTurns } : {}),
  };
}

// ----------------------------------------------------------------- text

/** What the agent reads back from the tool. */
export function describeDelegation(details: DelegateDetails): string {
  if (details.status === 'completed') {
    return details.result ?? '';
  }
  if (details.status === 'cancelled') {
    return `Claude delegation was cancelled. ${details.error?.message ?? ''}`.trim();
  }
  return `Claude delegation failed (${details.error?.kind ?? 'unknown'}): ${details.error?.message ?? 'no detail'}`;
}

/** The reply the smoke test looks for. */
export const SMOKE_MARKER = 'HAIKU_TOOL_OK';
export const SMOKE_PROMPT = `Reply with exactly this text and nothing else: ${SMOKE_MARKER}`;

/** One line for `/claude-smoke`: the outcome, the models, the session and the cost. */
export function smokeLine(details: DelegateDetails): string {
  const replied =
    details.status === 'completed' &&
    (details.result ?? '').includes(SMOKE_MARKER);
  const models = details.actualModels.length
    ? details.actualModels.join(', ')
    : 'none reported';
  const cost =
    details.billing.apiEquivalentUsd === null
      ? 'unknown'
      : `$${details.billing.apiEquivalentUsd.toFixed(6)}`;
  const problem = details.error
    ? `error ${details.error.kind}: ${details.error.message}`
    : replied
      ? null
      : `reply did not contain ${SMOKE_MARKER}`;

  return [
    `claude-smoke: ${replied ? 'ok' : 'FAILED'}`,
    `status ${details.status}`,
    `model ${models} (requested ${details.requestedModel}, ${details.modelSelection})`,
    `session ${details.claudeSessionId ?? 'none'}`,
    `costBasis list, apiEquivalentUsd ${cost}`,
    problem,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}
