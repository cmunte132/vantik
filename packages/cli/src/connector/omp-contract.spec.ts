/**
 * The contract between the connector and a real omp.
 *
 * It runs the real `omp` binary in RPC mode against a mock model server, with
 * the bundled Vantik extension, through the real `OmpDriver`. It checks what
 * the server and the connector depend on: the RPC handshake, the event
 * stream, the tools of the extension, the outbox and the session entries.
 *
 * It is off by default, because it needs omp on the PATH. Run it with
 * `pnpm test:omp-contract`, and on every bump of the omp version range in
 * `omp-version.ts`.
 *
 * It never reads or writes the person's `~/.omp`: the agent directory and the
 * home directory are temporary, and the model server is on localhost.
 */
import type { AddressInfo } from 'node:net';

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverOmp, ompArgs, spawnOmp } from './omp';
import { isSupportedOmpVersion } from './omp-version';
import { OmpDriver, type OmpEvent } from './rpc';

// eslint-disable-next-line turbo/no-undeclared-env-vars -- opt-in switch of this test only.
const enabled = process.env.OMP_CONTRACT === '1';
const ompFound = (() => {
  try {
    execFileSync('omp', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const packageDir = path.resolve(__dirname, '..', '..');
const extensionPath = path.join(
  packageDir,
  'dist',
  'pi-extension',
  'vantik-extension.js',
);

/** One turn of the mock model: a tool call, or plain text. */
type Turn = { tool: string; args: Record<string, unknown> } | { text: string };

const sse = (chunks: unknown[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

function completion(turn: Turn): string {
  const base = {
    id: 'mock-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock-1',
  };
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if ('tool' in turn) {
    return sse([
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call_${turn.tool}`,
                  type: 'function',
                  function: {
                    name: turn.tool,
                    arguments: JSON.stringify(turn.args),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage,
      },
    ]);
  }
  return sse([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: turn.text },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage,
    },
  ]);
}

/**
 * A mock chat-completions server. The turn is chosen by the number of tool
 * results already in the conversation, so a retried request gets the same
 * answer.
 */
function startMockModel(turns: Turn[]): Promise<{
  server: Server;
  baseUrl: string;
  requests: Array<Record<string, any>>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body || '{}') as Record<string, any>;
      requests.push(parsed);
      const results = (parsed.messages ?? []).filter(
        (m: { role?: string }) => m.role === 'tool',
      ).length;
      const turn = turns[Math.min(results, turns.length - 1)]!;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.end(completion(turn));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, requests });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(enabled && ompFound ? describe : describe.skip)('omp contract', () => {
  jest.setTimeout(180_000);

  let root: string;
  let mock: Awaited<ReturnType<typeof startMockModel>>;
  let driver: OmpDriver | undefined;

  beforeAll(async () => {
    // Build the extension when it is missing or older than its source, so the
    // test never checks a stale bundle.
    const source = path.resolve(
      packageDir,
      '../../apps/server/src/modules/agent-runs/pi-extension/vantik-extension.ts',
    );
    if (
      !existsSync(extensionPath) ||
      statSync(extensionPath).mtimeMs < statSync(source).mtimeMs
    ) {
      execFileSync('pnpm', ['exec', 'tsup'], {
        cwd: packageDir,
        stdio: 'inherit',
      });
    }
    root = mkdtempSync(path.join(tmpdir(), 'omp-contract-'));
    mock = await startMockModel([
      { tool: 'vantik_note', args: { body: 'contract note' } },
      {
        tool: 'ask_person',
        args: {
          questions: [
            {
              id: 'pick',
              prompt: 'Which one?',
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
        },
      },
      { text: 'All done.' },
    ]);
  });

  afterAll(async () => {
    driver?.kill('SIGKILL');
    await new Promise((resolve) => mock.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the handshake, the event stream and the extension intact', async () => {
    const version = (await discoverOmp()).version;
    expect(isSupportedOmpVersion(version)).toBe(true);

    const home = path.join(root, 'home');
    const agentDir = path.join(root, 'agent');
    const work = path.join(root, 'work');
    const runDir = path.join(root, 'run');
    for (const dir of [home, agentDir, work, runDir]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(
      path.join(agentDir, 'models.yml'),
      [
        'providers:',
        '  mock:',
        `    baseUrl: ${mock.baseUrl}`,
        '    apiKey: contract-test-key',
        '    api: openai-completions',
        '    models:',
        '      - id: mock-1',
        '        name: Mock One',
        '',
      ].join('\n'),
    );

    const outboxPath = path.join(runDir, 'vantik-outbox.jsonl');
    const policyPath = path.join(runDir, 'vantik-policy.json');
    writeFileSync(outboxPath, '');
    writeFileSync(path.join(runDir, 'context.json'), '{}');
    writeFileSync(
      policyPath,
      JSON.stringify({
        repoRoot: work,
        pathPrefixes: [],
        checks: [],
        reachableHosts: [],
        contextPath: path.join(runDir, 'context.json'),
        outboxPath,
        questionWaitMs: 60_000,
      }),
    );

    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      VANTIK_POLICY: policyPath,
    };
    for (const name of [
      'ACCESS_TOKEN',
      'VANTIK_TOKEN',
      'VANTIK_URL',
      'VANTIK_API_URL',
    ]) {
      delete env[name];
    }

    const child = spawnOmp(
      ompArgs(
        {
          model: { provider: 'mock', model: 'mock-1', thinking: null },
          resumeSessionId: null,
        },
        extensionPath,
      ),
      { cwd: work, env },
    );
    driver = new OmpDriver(child);
    const omp = driver;

    const events: OmpEvent[] = [];
    omp.onEvent((event) => events.push(event));

    // Stands in for the connector: a person answers the question of the tool.
    let answered = false;
    const answerer = setInterval(() => {
      for (const line of readFileSync(outboxPath, 'utf8').split('\n')) {
        if (!line.trim() || answered) {
          continue;
        }
        const item = JSON.parse(line) as { type?: string; id?: string };
        if (item.type === 'question' && item.id) {
          const answers = path.join(runDir, 'answers');
          mkdirSync(answers, { recursive: true });
          writeFileSync(
            path.join(answers, `${item.id}.json`),
            JSON.stringify({
              status: 'answered',
              text: 'Pick: B',
              answers: [{ id: 'pick', selected: ['B'] }],
            }),
          );
          answered = true;
        }
      }
    }, 200);

    try {
      await omp.negotiate();
      await omp.setAskDialog(true);
      const state = await omp.getState();
      expect(state.sessionId).toMatch(/\S+/);

      const idle = omp.waitForIdle({ settleMs: 800, pollMs: 200 });
      idle.catch(() => undefined);
      await omp.prompt('Take a note, ask which one, then finish.');
      await idle;

      // The event stream that the server reads.
      const types = events.map((e) => e.type);
      expect(types).toContain('agent_start');
      expect(types).toContain('message_end');
      // omp 18.8 sends `prompt_result` and `session_settled` after `agent_end`.
      expect(types.lastIndexOf('agent_end')).toBeGreaterThan(
        types.lastIndexOf('tool_execution_end'),
      );
      expect(types.filter((t) => t.startsWith('agent_')).pop()).toBe(
        'agent_end',
      );
      const starts = events.filter((e) => e.type === 'tool_execution_start');
      const ends = events.filter((e) => e.type === 'tool_execution_end');
      expect(starts.map((e) => e.toolName)).toEqual([
        'vantik_note',
        'ask_person',
      ]);
      expect(ends.map((e) => e.toolName)).toEqual([
        'vantik_note',
        'ask_person',
      ]);
      expect(
        ends
          .filter((e) => e.isError === true)
          .map((e) => JSON.stringify(e.result)),
      ).toEqual([]);
      expect(starts[0]!.toolCallId).toBeTruthy();
      expect(types.indexOf('agent_start')).toBeLessThan(
        types.indexOf('tool_execution_start'),
      );

      const last = omp.lastAssistantMessage;
      expect(last?.text).toBe('All done.');
      expect(last?.stopReason).not.toBe('error');

      // The extension's tools are loaded.
      const full = await omp.request({ type: 'get_state' });
      const tools = (
        (full.data as { dumpTools?: Array<{ name: string }> }).dumpTools ?? []
      ).map((t) => t.name);
      expect(tools).toEqual(
        expect.arrayContaining([
          'ask_person',
          'vantik_note',
          'vantik_issue',
          'vantik_knowledge',
          'vantik_criterion_met',
          'vantik_remember',
        ]),
      );

      // The tools queued to the outbox.
      const outbox = readFileSync(outboxPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; body?: string });
      expect(outbox.find((i) => i.type === 'note')?.body).toBe('contract note');
      expect(outbox.some((i) => i.type === 'question')).toBe(true);

      // The answer reached the model as a tool result.
      const lastRequest = mock.requests[mock.requests.length - 1]!;
      expect(JSON.stringify(lastRequest.messages)).toContain('Pick: B');

      // The extension's custom entries leave through get_entries.
      let entries: unknown[] = [];
      for (let i = 0; i < 10 && entries.length === 0; i += 1) {
        entries = await omp.pollEntries();
        if (entries.length === 0) {
          await sleep(300);
        }
      }
      expect(
        entries.some(
          (e) =>
            (e as { customType?: string }).customType === 'vantik.model_call',
        ),
      ).toBe(true);
    } finally {
      clearInterval(answerer);
    }
  });
});
