import type { ConnectorRunDispatch } from '@vantikhq/types';

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FileTail, ompArgs, ompEnv, parseOmpVersion } from './omp';
import { buildPolicy, installMcpOverride, seedRunDir } from './seed';
import { commitWorktree, excludeRunFiles } from './worktree';

const dispatch = {
  runId: 'run-1',
  issue: { id: 'i', key: 'ENG-1', title: 'T' },
  repo: { id: 'r', fullName: 'acme/api', path: '/src/api', baseRef: 'main' },
  branch: 'agent/eng-1',
  prompt: 'Do the thing.',
  context: { issue: { key: 'ENG-1' } },
  policy: {
    pathPrefixes: ['apps/server'],
    checks: ['pnpm test'],
    reachableHosts: ['registry.npmjs.org'],
    maxOutputTokens: 16000,
  },
  model: {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    thinking: 'high',
  },
  token: {
    value: 'run-token',
    apiUrl: 'https://v.example/api',
    expiresAt: 'x',
  },
  deadlineAt: '2099-01-01T00:00:00Z',
} as unknown as ConnectorRunDispatch;

describe('seeding a run directory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vantik-seed-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the policy with paths on this machine, plus context, prompt and an empty outbox', () => {
    const seeded = seedRunDir(path.join(dir, 'run-1'), '/wt/ENG-1', dispatch);

    expect(JSON.parse(readFileSync(seeded.policyPath, 'utf8'))).toEqual({
      repoRoot: '/wt/ENG-1',
      pathPrefixes: ['apps/server'],
      checks: ['pnpm test'],
      reachableHosts: ['registry.npmjs.org'],
      contextPath: seeded.contextPath,
      outboxPath: seeded.outboxPath,
      maxOutputTokens: 16000,
    });
    expect(JSON.parse(readFileSync(seeded.contextPath, 'utf8'))).toEqual(
      dispatch.context,
    );
    expect(readFileSync(seeded.outboxPath, 'utf8')).toBe('');
    expect(readFileSync(seeded.promptPath, 'utf8')).toBe('Do the thing.');
  });

  it('leaves out a null token cap and coerces checks that are not a list', () => {
    const policy = buildPolicy(
      {
        policy: {
          pathPrefixes: [],
          checks: null,
          reachableHosts: [],
          maxOutputTokens: null,
          questionWaitMs: null,
        },
      },
      { repoRoot: '/r', contextPath: '/c', outboxPath: '/o' },
    );
    expect(policy).toEqual({
      repoRoot: '/r',
      pathPrefixes: [],
      checks: [],
      reachableHosts: [],
      contextPath: '/c',
      outboxPath: '/o',
    });
  });
});

describe('the omp command for a run', () => {
  it('loads only the Vantik extension and runs without approval prompts', () => {
    const args = ompArgs(dispatch, '/ext/vantik-extension.js');
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--approval-mode',
      'yolo',
      '--no-ui',
      '--no-title',
      '--no-extensions',
      '-e',
      '/ext/vantik-extension.js',
      '--model',
      'anthropic/claude-sonnet-5-5',
      '--thinking',
      'high',
    ]);
  });

  it('leaves the model to omp when the dispatch names none, and skips an unknown thinking level', () => {
    const args = ompArgs(
      { model: { provider: null, model: null, thinking: 'sideways' } },
      '/e.js',
    );
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--thinking');
  });

  it('gives omp the run token and no other Vantik credential', () => {
    const env = ompEnv(
      {
        PATH: '/bin',
        ACCESS_TOKEN: 'personal',
        VANTIK_TOKEN: 'personal',
        BASE_HOST: 'h',
      },
      {
        token: dispatch.token,
        policyPath: '/p.json',
        emptyConfigDir: '/empty',
      },
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      VANTIK_TOKEN: 'run-token',
      VANTIK_API_URL: 'https://v.example/api',
      VANTIK_POLICY: '/p.json',
      VANTIK_CONFIG_DIR: '/empty',
    });
    expect(env.ACCESS_TOKEN).toBeUndefined();
    expect(env.BASE_HOST).toBeUndefined();
  });

  it('reads the version omp prints', () => {
    expect(parseOmpVersion('omp/18.8.6\n')).toBe('18.8.6');
    expect(parseOmpVersion('omp v18.8.6')).toBe('18.8.6');
    expect(parseOmpVersion('garbage')).toBeNull();
  });
});

describe('tailing the outbox', () => {
  it('returns complete lines once and holds a partial line for its newline', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vantik-tail-'));
    const file = path.join(dir, 'outbox.jsonl');
    try {
      const tail = new FileTail(file);
      expect(tail.read()).toEqual([]);

      writeFileSync(file, '{"a":1}\n{"b"');
      expect(tail.read()).toEqual(['{"a":1}']);
      expect(tail.read()).toEqual([]);

      writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":3}\n');
      expect(tail.read()).toEqual(['{"b":2}', '{"c":3}']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the run token as the only Vantik identity in omp', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const mcp = () => path.join(dir, '.omp', 'mcp.json');

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vantik-mcp-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a project-level vantik server on the run token, shaped like a person's own", () => {
    installMcpOverride(dir, dispatch.token, 'run-1');
    expect(JSON.parse(readFileSync(mcp(), 'utf8'))).toEqual({
      mcpServers: {
        vantik: {
          type: 'http',
          url: 'https://v.example/api/v1/mcp',
          headers: { Authorization: 'Bearer run-token' },
          'x-vantik-run': 'run-1',
        },
      },
    });
  });

  it('removes what it made, and puts back a file the repository had', () => {
    const restore = installMcpOverride(dir, dispatch.token, 'run-1');
    restore();
    expect(existsSync(path.join(dir, '.omp'))).toBe(false);

    mkdirSync(path.join(dir, '.omp'));
    const own = JSON.stringify({ mcpServers: { docs: { url: 'http://d' } } });
    writeFileSync(mcp(), own);
    const again = installMcpOverride(dir, dispatch.token, 'run-1');
    expect(
      Object.keys(JSON.parse(readFileSync(mcp(), 'utf8')).mcpServers),
    ).toEqual(['docs', 'vantik']);
    again();
    expect(readFileSync(mcp(), 'utf8')).toBe(own);
  });

  it('keeps the file out of git status and out of the run commit', async () => {
    await excludeRunFiles(dir);
    await excludeRunFiles(dir);
    installMcpOverride(dir, dispatch.token, 'run-1');
    expect(git('status', '--porcelain')).toBe('');
    expect(
      readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').match(
        /\/\.omp\/mcp\.json/g,
      ),
    ).toHaveLength(1);

    const base = git('rev-parse', 'HEAD');
    // Even a file git would otherwise track, because the repository has one.
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    const result = await commitWorktree({
      worktreePath: dir,
      branch: 'main',
      baseCommit: base,
      message: 'work',
    });
    expect(result.headCommit).not.toBeNull();
    expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('b.txt');
  });

  it('does not commit it when it is the only change, even if the repository tracks one', async () => {
    mkdirSync(path.join(dir, '.omp'));
    writeFileSync(mcp(), '{}');
    git('add', '-A');
    git('commit', '-q', '-m', 'tracked');
    const base = git('rev-parse', 'HEAD');

    installMcpOverride(dir, dispatch.token, 'run-1');
    expect(git('status', '--porcelain')).toContain('.omp/mcp.json');
    const result = await commitWorktree({
      worktreePath: dir,
      branch: 'main',
      baseCommit: base,
      message: 'work',
    });
    expect(result).toEqual({ branch: null, headCommit: null });
  });

  it("does not take a crashed run's override for the repository's own file", () => {
    installMcpOverride(dir, dispatch.token, 'run-crashed');
    // The crash: no restore. The next run finds the old override.
    const restore = installMcpOverride(dir, dispatch.token, 'run-2');
    expect(
      JSON.parse(readFileSync(mcp(), 'utf8')).mcpServers.vantik['x-vantik-run'],
    ).toBe('run-2');
    restore();
    expect(existsSync(mcp())).toBe(false);

    // With another server in the file, only that server is kept as prior.
    mkdirSync(path.join(dir, '.omp'), { recursive: true });
    writeFileSync(
      mcp(),
      JSON.stringify({
        mcpServers: {
          docs: { url: 'http://d' },
          vantik: { url: 'http://old', 'x-vantik-run': 'run-crashed' },
        },
      }),
    );
    installMcpOverride(dir, dispatch.token, 'run-3')();
    expect(JSON.parse(readFileSync(mcp(), 'utf8'))).toEqual({
      mcpServers: { docs: { url: 'http://d' } },
    });
  });
});
