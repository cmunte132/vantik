import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  checkAuth,
  CHILD_MARKER,
  type Checkpoint,
  createCheckpointStore,
  type CheckpointStore,
  type DelegateDeps,
  type DelegateRequest,
  delegate,
  judgeRun,
  parseDelegateParams,
  parseResultJson,
  plannedSessionId,
  type ProcessOutcome,
  recordCheckpoint,
  resultFailure,
  runProcess,
  sanitizeEnv,
} from './claude-cli';

/** The native session the default request, from the default OMP session and call, plans. */
const SESSION = plannedSessionId('omp-session-1', 'call-1');
const AUTH_OK = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
  email: 'nobody@example.com',
});

/**
 * A stand-in for the `claude` binary. It answers `auth status` from FAKE_AUTH,
 * and for a run it logs its arguments, reads the prompt from stdin, then
 * replies with FAKE_RESULT and exits FAKE_EXIT. FAKE_MODE picks the other
 * behaviours: `hang` and `trap` wait forever (trap ignores SIGTERM), and `big`
 * writes far more than an output limit.
 */
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  fs.appendFileSync(path.join(dir, 'auth-calls'), 'x\\n');
  process.stdout.write(process.env.FAKE_AUTH || '');
  process.exit(0);
}
fs.appendFileSync(path.join(dir, 'run-calls'), JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_MODE || 'result';
if (mode === 'trap') {
  process.on('SIGTERM', () => {});
}
if (mode === 'hang' || mode === 'trap') {
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'big') {
  process.stdout.write('x'.repeat(200000));
} else {
  fs.readFileSync(0, 'utf8');
  process.stdout.write(process.env.FAKE_RESULT || '');
  process.exit(Number(process.env.FAKE_EXIT || 0));
}
`;

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-cli-'));
  const binary = join(dir, 'claude');
  writeFileSync(binary, `#!${process.execPath}\n${FAKE_CLAUDE}`, {
    mode: 0o755,
  });
  return {
    dir,
    binary,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function resultJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
    result: 'HAIKU_TOOL_OK',
    session_id: SESSION,
    total_cost_usd: 0.5,
    num_turns: 1,
    usage: { input_tokens: 12, output_tokens: 3 },
    modelUsage: {
      'claude-haiku-5-5': {
        provider: 'firstParty',
        costBasis: 'list',
        canonicalModel: 'claude-haiku-5-5',
        inputTokens: 12,
        outputTokens: 3,
        costUSD: 0.5,
      },
    },
    permission_denials: [],
    ...overrides,
  });
}

function runsOf(dir: string): string[][] {
  const file = join(dir, 'run-calls');
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function authCallsOf(dir: string): number {
  const file = join(dir, 'auth-calls');
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').length - 1
    : 0;
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(file)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${file} never appeared`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function finished(overrides: Partial<ProcessOutcome> = {}): ProcessOutcome {
  return {
    reason: 'exit',
    reaped: true,
    spawnError: null,
    exitCode: 0,
    exitSignal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

function request(
  dir: string,
  overrides: Partial<DelegateRequest> = {},
): DelegateRequest {
  return {
    prompt: 'Reply with HAIKU_TOOL_OK.',
    intent: 'execution',
    cwd: dir,
    invocationId: 'call-1',
    ompSessionId: 'omp-session-1',
    ...overrides,
  };
}

function depsFor(
  fixture: { dir: string; binary: string },
  store: CheckpointStore,
  overrides: Record<string, string> = {},
): DelegateDeps {
  return {
    binary: fixture.binary,
    env: {
      ...process.env,
      FAKE_DIR: fixture.dir,
      FAKE_AUTH: AUTH_OK,
      FAKE_RESULT: resultJson(),
      ...overrides,
    },
    store,
    now: () => '2026-10-21T00:00:00.000Z',
  };
}

describe('the environment the child runs in', () => {
  it('drops API keys, other providers and the host’s own variables, and keeps the login home', () => {
    const env = sanitizeEnv({
      HOME: '/home/u',
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-alt',
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_MODEL: 'some-model',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      ACCESS_TOKEN: 'access',
      VANTIK_POLICY: '/tmp/policy.json',
    });

    expect(env).toEqual({
      HOME: '/home/u',
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-alt',
      [CHILD_MARKER]: '1',
    });
  });
});

describe('the parameters of a delegation', () => {
  it('refuses what it cannot run safely, before anything starts', () => {
    const base = { prompt: 'x', intent: 'execution' };
    for (const params of [
      { ...base, prompt: '  ' },
      { ...base, intent: 'chat' },
      { ...base, cwd: 'relative/dir' },
      { ...base, toolProfile: 'bash' },
      { ...base, timeoutMs: 3600001 },
      { ...base, timeoutMs: 0 },
      { ...base, model: 'bad model id' },
      { ...base, resumeSessionId: '../escape' },
      { ...base, maxTurns: 0 },
    ]) {
      expect(() => parseDelegateParams(params, '/work/repo')).toThrow();
    }
  });
});

describe('judging a finished run', () => {
  it('does not count a rejected login as success just because its subtype says success', () => {
    const result = JSON.parse(
      resultJson({
        is_error: true,
        api_error_status: 401,
        result: 'Invalid authentication credentials',
      }),
    ) as Record<string, unknown>;

    const judged = judgeRun(
      finished({ stdout: JSON.stringify(result) }),
      result,
      1000,
    );

    expect(judged.status).toBe('failed');
    expect(judged.error?.kind).toBe('auth');
  });

  it('treats a non-zero exit as a failure even when the result reads as success', () => {
    const result = JSON.parse(resultJson()) as Record<string, unknown>;

    const judged = judgeRun(finished({ exitCode: 1 }), result, 1000);

    expect(judged.status).toBe('failed');
  });

  it('reports a subscription limit as quota, not as a model error', () => {
    const failure = resultFailure(
      JSON.parse(
        resultJson({
          is_error: true,
          api_error_status: 429,
          result: 'rate limit reached',
        }),
      ) as Record<string, unknown>,
    );

    expect(failure?.kind).toBe('quota');
  });

  it('calls a finished run with no result a bad output, not a success', () => {
    expect(
      judgeRun(finished({ stdout: 'not json' }), null, 1000),
    ).toMatchObject({
      status: 'failed',
      error: { kind: 'bad-output' },
    });
  });

  it('maps a stop to the matching status, and says when the process was not confirmed gone', () => {
    expect(
      judgeRun(finished({ reason: 'cancelled', exitCode: null }), null, 1000),
    ).toMatchObject({ status: 'cancelled', error: { kind: 'cancelled' } });
    expect(
      judgeRun(
        finished({ reason: 'timeout', reaped: false, exitCode: null }),
        null,
        1000,
      ).error?.message,
    ).toMatch(/did not confirm exit/);
  });

  it('does not read output that is not the one result object it asked for', () => {
    expect(parseResultJson('garbage')).toBeNull();
    expect(parseResultJson('')).toBeNull();
    expect(parseResultJson('{"type":"assistant"}')).toBeNull();
  });
});

describe('cost checkpoints', () => {
  const input = (invocationId: string, cumulativeUsd: number) => ({
    claudeSessionId: SESSION,
    ompSessionId: 'omp-session-1',
    invocationId,
    cumulativeUsd,
    now: '2026-10-21T00:00:00.000Z',
  });

  it('books a new session at its total', () => {
    const recorded = recordCheckpoint(null, input('call-1', 0.5));

    expect(recorded.deltaUsd).toBe(0.5);
    expect(recorded.checkpoint.cumulativeApiEquivalentUsd).toBe(0.5);
    expect(recorded.counterReset).toBe(false);
  });

  it('books a resumed session at its growth, never at the whole conversation again', () => {
    const first = recordCheckpoint(null, input('call-1', 0.5));
    const second = recordCheckpoint(first.checkpoint, input('call-2', 0.8));

    expect(second.deltaUsd).toBeCloseTo(0.3, 9);
    expect(second.checkpoint.cumulativeApiEquivalentUsd).toBe(0.8);
  });

  it('books a repeated invocation once, returning the same delta', () => {
    const first = recordCheckpoint(null, input('call-1', 0.5));
    const again = recordCheckpoint(first.checkpoint, input('call-2', 0.8));
    const replay = recordCheckpoint(again.checkpoint, input('call-2', 0.8));

    expect(replay.deltaUsd).toBeCloseTo(0.3, 9);
    expect(replay.checkpoint).toBe(again.checkpoint);
  });

  it('marks a falling counter as reset with an unknown delta, never a negative one', () => {
    const first = recordCheckpoint(null, input('call-1', 2));
    const reset = recordCheckpoint(first.checkpoint, input('call-2', 1));

    expect(reset.counterReset).toBe(true);
    expect(reset.deltaUsd).toBeNull();
    expect(reset.checkpoint.cumulativeApiEquivalentUsd).toBe(1);
  });
});

describe('the checkpoint store', () => {
  let dir: string;
  let store: CheckpointStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-store-'));
    store = createCheckpointStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a damaged checkpoint as no baseline rather than a zero one', () => {
    store.write({
      v: 1,
      claudeSessionId: SESSION,
      ompSessionId: null,
      cumulativeApiEquivalentUsd: 0.5,
      invocations: [],
      updatedAt: '2026-10-21T00:00:00.000Z',
    });
    const file = join(
      dir,
      'sessions',
      `${createHash('sha256').update(SESSION).digest('hex')}.json`,
    );
    writeFileSync(file, '{"v":1,');

    expect(store.read(SESSION)).toBeNull();
  });

  it('lets one run hold a session at a time, and frees it when released', () => {
    const release = store.lock(SESSION);

    expect(release).not.toBeNull();
    expect(store.lock(SESSION)).toBeNull();

    release?.();

    expect(store.lock(SESSION)).not.toBeNull();
  });

  it('does not clear a leftover lock on its own, even when its owner is gone', () => {
    const leftover = join(
      dir,
      'locks',
      `${createHash('sha256').update(SESSION).digest('hex')}.lock`,
    );
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(
      leftover,
      JSON.stringify({ token: 'left-behind', pid: 2147483646 }),
    );

    expect(store.lock(SESSION)).toBeNull();
    expect(existsSync(leftover)).toBe(true);
  });
});

describe('the login check', () => {
  let fixture: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => fixture.cleanup());

  it('accepts a claude.ai first-party login and shows only the method and plan', async () => {
    const auth = await checkAuth(
      depsFor(fixture, createCheckpointStore(fixture.dir)),
      fixture.dir,
    );

    expect(auth).toEqual({ ok: true, authMethod: 'claude.ai', plan: 'max' });
    expect(JSON.stringify(auth)).not.toContain('nobody@example.com');
  });

  it('fails closed on an API-key login, a provider route, or no login', async () => {
    const store = createCheckpointStore(fixture.dir);
    for (const status of [
      { loggedIn: true, authMethod: 'api-key', apiProvider: 'firstParty' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' },
      { loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty' },
    ]) {
      const auth = await checkAuth(
        depsFor(fixture, store, { FAKE_AUTH: JSON.stringify(status) }),
        fixture.dir,
      );
      expect(auth.ok).toBe(false);
    }
  });

  it('fails closed when the status is not JSON', async () => {
    const auth = await checkAuth(
      depsFor(fixture, createCheckpointStore(fixture.dir), {
        FAKE_AUTH: 'logged in, probably',
      }),
      fixture.dir,
    );

    expect(auth.ok).toBe(false);
  });
});

describe('running the process', () => {
  let fixture: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => fixture.cleanup());

  const runFake = (
    mode: string,
    overrides: Partial<Parameters<typeof runProcess>[0]> = {},
  ) =>
    runProcess({
      binary: fixture.binary,
      args: ['--print'],
      cwd: fixture.dir,
      env: { ...process.env, FAKE_DIR: fixture.dir, FAKE_MODE: mode },
      input: 'prompt',
      timeoutMs: 20_000,
      ...overrides,
    });

  it('stops a run on timeout, and leaves no process behind', async () => {
    const run = runFake('hang', { timeoutMs: 1500 });
    await waitForFile(join(fixture.dir, 'pid'));

    const outcome = await run;
    const pid = Number(readFileSync(join(fixture.dir, 'pid'), 'utf8'));

    expect(outcome.reason).toBe('timeout');
    expect(outcome.reaped).toBe(true);
    expect(isAlive(pid)).toBe(false);
  });

  it('stops a run on abort, and leaves no process behind', async () => {
    const controller = new AbortController();
    const run = runFake('hang', { signal: controller.signal });
    await waitForFile(join(fixture.dir, 'pid'));

    controller.abort();
    const outcome = await run;
    const pid = Number(readFileSync(join(fixture.dir, 'pid'), 'utf8'));

    expect(outcome.reason).toBe('cancelled');
    expect(isAlive(pid)).toBe(false);
  }, 15_000);

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const controller = new AbortController();
    const run = runFake('trap', { signal: controller.signal });
    await waitForFile(join(fixture.dir, 'pid'));

    controller.abort();
    const outcome = await run;
    const pid = Number(readFileSync(join(fixture.dir, 'pid'), 'utf8'));

    expect(outcome.reason).toBe('cancelled');
    expect(outcome.reaped).toBe(true);
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  it('stops a run that writes past its output limit, rather than cutting its JSON short', async () => {
    const outcome = await runFake('big', { maxStdoutBytes: 1000 });

    expect(outcome.reason).toBe('output-limit');
  });

  it('reports a binary that is not there as a spawn failure', async () => {
    const outcome = await runProcess({
      binary: join(fixture.dir, 'no-such-claude'),
      args: [],
      cwd: fixture.dir,
      env: {},
      input: '',
      timeoutMs: 5000,
    });

    expect(outcome.reason).toBe('spawn-error');
  });
});

describe('a delegation', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let store: CheckpointStore;

  beforeEach(() => {
    fixture = makeFixture();
    store = createCheckpointStore(join(fixture.dir, 'store'));
  });

  afterEach(() => fixture.cleanup());

  it('runs the CLI with the prompt on stdin, never in its arguments', async () => {
    const details = await delegate(
      request(fixture.dir),
      depsFor(fixture, store),
    );

    expect(details.status).toBe('completed');
    expect(details.result).toBe('HAIKU_TOOL_OK');
    expect(runsOf(fixture.dir)[0]).not.toContain('Reply with HAIKU_TOOL_OK.');
  });

  it('books a resume at its growth and keeps the lock only for the run', async () => {
    await delegate(request(fixture.dir), depsFor(fixture, store));

    const resumed = await delegate(
      request(fixture.dir, {
        invocationId: 'call-2',
        resumeSessionId: SESSION,
      }),
      depsFor(fixture, store, {
        FAKE_RESULT: resultJson({ total_cost_usd: 0.8 }),
      }),
    );

    expect(resumed.status).toBe('completed');
    expect(resumed.resumed).toBe(true);
    expect(resumed.billing.deltaApiEquivalentUsd).toBeCloseTo(0.3, 9);
    expect(store.read(SESSION)?.cumulativeApiEquivalentUsd).toBe(0.8);
    expect(store.lock(SESSION)).not.toBeNull();
  });

  it('refuses a resume with no baseline, and runs nothing', async () => {
    const details = await delegate(
      request(fixture.dir, { resumeSessionId: 'unknown-session-id' }),
      depsFor(fixture, store),
    );

    expect(details.status).toBe('failed');
    expect(details.error?.kind).toBe('unknown-baseline');
    expect(runsOf(fixture.dir)).toEqual([]);
  });

  it('refuses a resume while another run holds the session', async () => {
    await delegate(request(fixture.dir), depsFor(fixture, store));
    const held = store.lock(SESSION);

    const details = await delegate(
      request(fixture.dir, { resumeSessionId: SESSION }),
      depsFor(fixture, store),
    );

    expect(held).not.toBeNull();
    expect(details.error?.kind).toBe('busy');
    expect(runsOf(fixture.dir)).toHaveLength(1);
  });

  it('does not book a resume that came back as a different session', async () => {
    await delegate(request(fixture.dir), depsFor(fixture, store));

    const details = await delegate(
      request(fixture.dir, {
        resumeSessionId: SESSION,
        invocationId: 'call-2',
      }),
      depsFor(fixture, store, {
        FAKE_RESULT: resultJson({
          session_id: 'other-session-0002',
          total_cost_usd: 0.9,
        }),
      }),
    );

    expect(details.status).toBe('failed');
    expect(details.error?.kind).toBe('session-mismatch');
    expect(details.billing.deltaApiEquivalentUsd).toBeNull();
    expect(store.read(SESSION)?.cumulativeApiEquivalentUsd).toBe(0.5);
  });

  it('fails on a rejected login that reports success, and tries nothing else', async () => {
    const details = await delegate(
      request(fixture.dir),
      depsFor(fixture, store, {
        FAKE_RESULT: resultJson({
          is_error: true,
          api_error_status: 401,
          result: 'Invalid authentication credentials',
        }),
        FAKE_EXIT: '1',
      }),
    );

    expect(details.status).toBe('failed');
    expect(details.error?.kind).toBe('auth');
    expect(runsOf(fixture.dir)).toHaveLength(1);
    expect(runsOf(fixture.dir)[0]).not.toContain('--fallback-model');
  });

  it('stops at a quota limit with one call, and sends nothing to another model', async () => {
    const details = await delegate(
      request(fixture.dir),
      depsFor(fixture, store, {
        FAKE_RESULT: resultJson({
          is_error: true,
          api_error_status: 429,
          result: 'usage limit reached',
        }),
        FAKE_EXIT: '1',
      }),
    );

    expect(details.error?.kind).toBe('quota');
    expect(runsOf(fixture.dir)).toHaveLength(1);
    expect(runsOf(fixture.dir)[0]).not.toContain('--fallback-model');
  });

  it('reports spend as unknown when the result carries no total', async () => {
    const details = await delegate(
      request(fixture.dir),
      depsFor(fixture, store, {
        FAKE_RESULT: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          terminal_reason: 'completed',
          result: 'ok',
          session_id: SESSION,
        }),
      }),
    );

    expect(details.status).toBe('completed');
    expect(details.billing.apiEquivalentUsd).toBeNull();
    expect(details.billing.deltaApiEquivalentUsd).toBeNull();
    expect(store.read(SESSION)).toBeNull();
  });

  it('will not start from inside a delegated run', async () => {
    const details = await delegate(
      request(fixture.dir),
      depsFor(fixture, store, { [CHILD_MARKER]: '1' }),
    );

    expect(details.error?.kind).toBe('recursion');
    expect(runsOf(fixture.dir)).toEqual([]);
    expect(authCallsOf(fixture.dir)).toBe(0);
  });

  it('runs nothing when the login is not a subscription', async () => {
    const details = await delegate(
      request(fixture.dir),
      depsFor(fixture, store, {
        FAKE_AUTH: JSON.stringify({
          loggedIn: true,
          authMethod: 'api-key',
          apiProvider: 'firstParty',
        }),
      }),
    );

    expect(details.error?.kind).toBe('auth');
    expect(runsOf(fixture.dir)).toEqual([]);
  });

  it('reports a cancelled run as cancelled, and leaves no inference behind', async () => {
    const controller = new AbortController();
    const run = delegate(
      request(fixture.dir, { signal: controller.signal }),
      depsFor(fixture, store, { FAKE_MODE: 'hang' }),
    );
    await waitForFile(join(fixture.dir, 'pid'));

    controller.abort();
    const details = await run;
    const pid = Number(readFileSync(join(fixture.dir, 'pid'), 'utf8'));

    expect(details.status).toBe('cancelled');
    expect(details.billing.apiEquivalentUsd).toBeNull();
    expect(isAlive(pid)).toBe(false);
  }, 15_000);

  it('refuses a repeat of a finished call before login or inference, and names its session', async () => {
    const first = await delegate(request(fixture.dir), depsFor(fixture, store));
    const runsBefore = runsOf(fixture.dir).length;
    const authBefore = authCallsOf(fixture.dir);

    const repeat = await delegate(
      request(fixture.dir),
      depsFor(fixture, store),
    );

    expect(first.status).toBe('completed');
    expect(repeat.status).toBe('failed');
    expect(repeat.error?.kind).toBe('duplicate');
    expect(repeat.claudeSessionId).toBe(SESSION);
    expect(repeat.billing.apiEquivalentUsd).toBeNull();
    expect(repeat.billing.deltaApiEquivalentUsd).toBeNull();
    expect(runsOf(fixture.dir)).toHaveLength(runsBefore);
    expect(authCallsOf(fixture.dir)).toBe(authBefore);
    expect(store.read(SESSION)?.cumulativeApiEquivalentUsd).toBe(0.5);
  });

  it('refuses a repeat of a finished resume the same way, and books nothing twice', async () => {
    await delegate(request(fixture.dir), depsFor(fixture, store));
    await delegate(
      request(fixture.dir, {
        invocationId: 'call-2',
        resumeSessionId: SESSION,
      }),
      depsFor(fixture, store, {
        FAKE_RESULT: resultJson({ total_cost_usd: 0.8 }),
      }),
    );
    const runsBefore = runsOf(fixture.dir).length;

    const repeat = await delegate(
      request(fixture.dir, {
        invocationId: 'call-2',
        resumeSessionId: SESSION,
      }),
      depsFor(fixture, store),
    );

    expect(repeat.error?.kind).toBe('duplicate');
    expect(runsOf(fixture.dir)).toHaveLength(runsBefore);
    expect(store.read(SESSION)?.cumulativeApiEquivalentUsd).toBe(0.8);
  });

  it('refuses an old invocation after a long-lived session without launching Claude', async () => {
    let checkpoint: Checkpoint | null = null;
    for (let index = 0; index < 1001; index += 1) {
      checkpoint = recordCheckpoint(checkpoint, {
        claudeSessionId: SESSION,
        ompSessionId: 'omp-session-1',
        invocationId: `call-${index}`,
        cumulativeUsd: 0.01 * (index + 1),
        now: '2026-10-21T00:00:00.000Z',
      }).checkpoint;
    }
    store.write(checkpoint as Checkpoint);

    const replay = await delegate(
      request(fixture.dir, {
        invocationId: 'call-0',
        resumeSessionId: SESSION,
      }),
      depsFor(fixture, store),
    );

    expect(replay.error?.kind).toBe('duplicate');
    expect(authCallsOf(fixture.dir)).toBe(0);
    expect(runsOf(fixture.dir)).toEqual([]);
    expect(store.read(SESSION)?.cumulativeApiEquivalentUsd).toBeCloseTo(
      10.01,
      9,
    );
  });

  it('lets only one of two concurrent calls for the same tool call reach Claude', async () => {
    const [a, b] = await Promise.all([
      delegate(request(fixture.dir), depsFor(fixture, store)),
      delegate(request(fixture.dir), depsFor(fixture, store)),
    ]);

    expect([a, b].filter((d) => d.status === 'completed')).toHaveLength(1);
    expect([a, b].filter((d) => d.error?.kind === 'busy')).toHaveLength(1);
    expect(runsOf(fixture.dir)).toHaveLength(1);
  });

  it('refuses a new call that finds a checkpoint it did not write, and does not reset the conversation', async () => {
    store.write({
      v: 1,
      claudeSessionId: SESSION,
      ompSessionId: 'omp-session-1',
      cumulativeApiEquivalentUsd: 2,
      invocations: [
        {
          invocationId: 'some-other-call',
          ompSessionId: 'omp-session-1',
          cumulativeApiEquivalentUsd: 2,
          deltaApiEquivalentUsd: 2,
        },
      ],
      updatedAt: '2026-10-21T00:00:00.000Z',
    });

    const details = await delegate(
      request(fixture.dir),
      depsFor(fixture, store),
    );

    expect(details.error?.kind).toBe('session-conflict');
    expect(runsOf(fixture.dir)).toEqual([]);
    expect(store.read(SESSION)?.cumulativeApiEquivalentUsd).toBe(2);
  });

  it('does not book a new call whose native session came back under another id', async () => {
    const details = await delegate(
      request(fixture.dir),
      depsFor(fixture, store, {
        FAKE_RESULT: resultJson({
          session_id: 'other-session-0003',
          total_cost_usd: 0.4,
        }),
      }),
    );

    expect(details.status).toBe('failed');
    expect(details.error?.kind).toBe('session-mismatch');
    expect(details.billing.deltaApiEquivalentUsd).toBeNull();
    expect(store.read(SESSION)).toBeNull();
  });

  it('keeps resuming a checkpoint written before planned sessions, under its random id', async () => {
    const legacy = 'legacy-session-0001';
    store.write({
      v: 1,
      claudeSessionId: legacy,
      ompSessionId: null,
      cumulativeApiEquivalentUsd: 1,
      invocations: [],
      updatedAt: '2026-10-21T00:00:00.000Z',
    });

    const details = await delegate(
      request(fixture.dir, { invocationId: 'call-9', resumeSessionId: legacy }),
      depsFor(fixture, store, {
        FAKE_RESULT: resultJson({ session_id: legacy, total_cost_usd: 1.4 }),
      }),
    );

    expect(details.status).toBe('completed');
    expect(details.billing.deltaApiEquivalentUsd).toBeCloseTo(0.4, 9);
  });
});

describe('the planned native session', () => {
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('is a well-formed UUID, the same every time for the same tool call', () => {
    const id = plannedSessionId('omp-1', 'call-1');

    expect(id).toMatch(UUID);
    expect(plannedSessionId('omp-1', 'call-1')).toBe(id);
  });

  it('differs by tool call and by OMP session', () => {
    const id = plannedSessionId('omp-1', 'call-1');

    expect(plannedSessionId('omp-1', 'call-2')).not.toBe(id);
    expect(plannedSessionId('omp-2', 'call-1')).not.toBe(id);
  });
});
