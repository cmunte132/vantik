/* eslint-disable turbo/no-undeclared-env-vars -- VANTIK_POLICY is the guest's, set here as the host would. */
import { AGENT_MAX_OUTPUT_TOKENS } from '@vantikhq/types';

import { extensionFiles, guardrailPolicy, POLICY_PATH } from './seed';
import vantik, {
  blockedReason,
  capModelCalls,
  capOutputTokens,
  checkReminder,
  checkToolCall,
  describeIssue,
  findKnowledge,
  GuardrailPolicy,
  hostsIn,
  PiTool,
  isCheckCommand,
  MODEL_CALL_ENTRY,
  repoRelative,
  reportModelCalls,
} from './vantik-extension';
import { guardrailOf, modelCallOf } from '../executors/pi-events';

const POLICY: GuardrailPolicy = {
  repoRoot: '/workspace/repo',
  pathPrefixes: ['apps/server/'],
  checks: ['pnpm --filter server test'],
  reachableHosts: ['registry.npmjs.org', 'proxy.golang.org'],
};

const rule = (tool: string, input: Record<string, unknown>) =>
  checkToolCall(tool, input, POLICY)?.rule ?? null;

describe('the Vantik extension’s rules', () => {
  it('stops git, which has nothing to work on here', () => {
    expect(rule('bash', { command: 'git status' })).toBe('no-git');
    expect(rule('bash', { command: 'cd apps && git diff' })).toBe('no-git');
    expect(rule('bash', { command: 'rg digit src' })).toBeNull();
    expect(rule('bash', { command: 'cat .gitignore' })).toBeNull();
  });

  it('stops a fetch from a host the sandbox cannot reach, and lets the reachable ones by', () => {
    expect(rule('bash', { command: 'curl -s https://pypi.org/simple/' })).toBe(
      'egress',
    );
    expect(
      rule('bash', { command: 'pip download git+ssh://git@github.com/a/b' }),
    ).toBe('egress');
    expect(
      rule('bash', { command: 'curl https://registry.npmjs.org/react' }),
    ).toBeNull();
    expect(
      rule('bash', { command: 'curl http://localhost:3000/health' }),
    ).toBeNull();
    expect(hostsIn('git clone git@gitlab.com:a/b.git')).toEqual(['gitlab.com']);
  });

  it('stops deleting the checkout wholesale', () => {
    expect(rule('bash', { command: 'rm -rf /workspace/repo' })).toBe(
      'destructive',
    );
    expect(rule('bash', { command: 'rm -rf .' })).toBe('destructive');
    expect(rule('bash', { command: 'rm -rf apps/server/dist' })).toBeNull();
  });

  it('stops edits outside the modules and to CI, and leaves scratch files alone', () => {
    expect(rule('write', { path: 'apps/server/src/a.ts' })).toBeNull();
    expect(
      rule('edit', { path: '/workspace/repo/apps/server/a.ts' }),
    ).toBeNull();
    expect(rule('write', { path: 'apps/webapp/a.ts' })).toBe('scope');
    expect(rule('write', { path: 'apps/server/../webapp/a.ts' })).toBe('scope');
    expect(rule('write', { path: '.forgejo/workflows/ci.yml' })).toBe('ci');
    expect(rule('write', { path: '/tmp/notes.md' })).toBeNull();
    expect(
      checkToolCall(
        'write',
        { path: 'anything.md' },
        { ...POLICY, pathPrefixes: [] },
      ),
    ).toBeNull();
  });

  it('resolves paths against the checkout', () => {
    expect(repoRelative('src/a.ts', '/workspace/repo')).toBe('src/a.ts');
    expect(
      repoRelative('/workspace/repo/./src/../b.ts', '/workspace/repo'),
    ).toBe('b.ts');
    expect(repoRelative('../prompt.md', '/workspace/repo')).toBeNull();
  });

  it('knows a check when it sees one', () => {
    expect(isCheckCommand('pnpm --filter server test -- foo', POLICY)).toBe(
      true,
    );
    expect(isCheckCommand('npx jest src/a.spec.ts', POLICY)).toBe(true);
    expect(isCheckCommand('ls src', POLICY)).toBe(false);
  });
});

describe('the Vantik extension in Pi', () => {
  function load(policy: GuardrailPolicy | null) {
    const handlers: Record<string, (event: unknown) => unknown> = {};
    const sent: string[] = [];
    const env = process.env.VANTIK_POLICY;
    const { writeFileSync, mkdtempSync } = jest.requireActual('node:fs');
    const { join } = jest.requireActual('node:path');
    const { tmpdir } = jest.requireActual('node:os');

    if (policy) {
      const path = join(mkdtempSync(join(tmpdir(), 'vantik-ext-')), 'p.json');
      writeFileSync(path, JSON.stringify(policy));
      process.env.VANTIK_POLICY = path;
    } else {
      delete process.env.VANTIK_POLICY;
    }

    vantik({
      on: (name, handler) => {
        handlers[name] = handler as (event: unknown) => unknown;
      },
      sendUserMessage: (content) => sent.push(content),
      appendEntry: () => undefined,
    });
    process.env.VANTIK_POLICY = env;

    return { handlers, sent };
  }

  it('blocks with a tagged reason the host can read back', () => {
    const { handlers } = load(POLICY);
    const result = handlers.tool_call({
      toolName: 'bash',
      toolCallId: 't1',
      input: { command: 'git log' },
    }) as { block: boolean; reason: string };

    expect(result.block).toBe(true);
    expect(
      guardrailOf({
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 't1',
        isError: true,
        result: { content: [{ type: 'text', text: result.reason }] },
      }),
    ).toEqual({
      rule: 'no-git',
      action: 'blocked',
      tool: 'bash',
      toolCallId: 't1',
    });
  });

  it('asks once for the checks when the agent edited and never ran them', () => {
    const { handlers, sent } = load(POLICY);

    handlers.tool_call({
      toolName: 'write',
      input: { path: 'apps/server/a.ts' },
    });
    handlers.agent_end({});
    handlers.agent_end({});

    expect(sent).toEqual([checkReminder(POLICY)]);
    expect(
      guardrailOf({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: sent[0] }] },
      }),
    ).toEqual({ rule: 'unchecked', action: 'continued' });
  });

  it('does not ask when the checks ran, or nothing was edited', () => {
    const ran = load(POLICY);
    ran.handlers.tool_call({
      toolName: 'write',
      input: { path: 'apps/server/a.ts' },
    });
    ran.handlers.tool_call({
      toolName: 'bash',
      input: { command: 'pnpm --filter server test' },
    });
    ran.handlers.agent_end({});

    const idle = load(POLICY);
    idle.handlers.agent_end({});

    expect([...ran.sent, ...idle.sent]).toEqual([]);
  });

  it('does nothing without a policy, rather than stop the run', () => {
    expect(Object.keys(load(null).handlers)).not.toContain('tool_call');
  });

  it('does not mistake a tool’s own failure for a guardrail', () => {
    expect(
      guardrailOf({
        type: 'tool_execution_end',
        toolName: 'bash',
        isError: true,
        result: {
          content: [
            {
              type: 'text',
              text: `oops ${blockedReason({ rule: 'no-git', reason: 'x' })}`,
            },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe('seeding the guest', () => {
  it('writes the extension and a policy built from the pack', () => {
    const pack = {
      repo: {
        pathPrefixes: ['src/'],
        testCommand: 'npm test',
        lintCommand: 'npm run lint',
      },
    } as never;
    const files = extensionFiles(pack, ['proxy.golang.org']);

    expect(Object.keys(files).sort()).toEqual([
      'vantik-extension.ts',
      'vantik-lsp.ts',
      POLICY_PATH,
    ]);
    expect(files['vantik-extension.ts']).toContain(
      'export default function vantik',
    );
    expect(JSON.parse(files[POLICY_PATH])).toEqual(
      guardrailPolicy(pack, ['proxy.golang.org']),
    );
    expect(guardrailPolicy(pack).checks).toEqual(['npm test', 'npm run lint']);
  });
});

describe('timing model calls', () => {
  function run(events: Array<[string, object]>) {
    const handlers: Record<string, (event: unknown) => unknown> = {};
    const entries: Array<{ customType: string; data: unknown }> = [];
    let clock = 1000;

    reportModelCalls(
      {
        on: (name, handler) => {
          handlers[name] = handler as (event: unknown) => unknown;
        },
        sendUserMessage: () => undefined,
        appendEntry: (customType, data) => entries.push({ customType, data }),
      },
      () => clock,
    );
    for (const [name, event] of events) {
      if (name === 'tick') {
        clock += (event as { ms: number }).ms;
      } else {
        handlers[name]?.(event);
      }
    }
    return entries;
  }

  const assistant = { message: { role: 'assistant' } };

  it('reports each call from the moment the request left, and the host reads it back', () => {
    const entries = run([
      ['before_provider_request', {}],
      ['tick', { ms: 300 }],
      ['after_provider_response', { status: 200, headers: { secret: 'x' } }],
      ['message_start', assistant],
      ['tick', { ms: 5 }],
      ['message_update', assistant],
      ['tick', { ms: 200 }],
      ['message_update', assistant],
      ['message_end', assistant],
    ]);

    expect(entries).toEqual([
      {
        customType: MODEL_CALL_ENTRY,
        data: {
          v: 1,
          status: 200,
          responseMs: 300,
          ttftMs: 305,
          durationMs: 505,
        },
      },
    ]);
    expect(modelCallOf({ type: 'entry_appended', entry: entries[0] })).toEqual({
      status: 200,
      responseMs: 300,
      ttftMs: 305,
      durationMs: 505,
    });
  });

  it('reports a refused call with only its duration, and nothing for user messages', () => {
    const entries = run([
      ['message_end', { message: { role: 'user' } }],
      ['before_provider_request', {}],
      ['tick', { ms: 16 }],
      ['message_end', assistant],
    ]);

    expect(entries.map((e) => e.data)).toEqual([{ v: 1, durationMs: 16 }]);
  });
});

describe('the Vantik tools', () => {
  const PACK = {
    issue: {
      key: 'ENG-42',
      title: 'Keep the last row',
      description: 'It drops it.',
    },
    definitionOfDone: [
      { id: 'c1', body: 'Keeps the last row', completed: false },
    ],
    knowledge: [
      {
        entryId: 'e1',
        kind: 'GOTCHA',
        scope: 'src/importer',
        body: 'Rows are paged by 500.',
      },
      {
        entryId: 'e2',
        kind: 'FACT',
        scope: null,
        body: 'Deploys go through Forgejo.',
      },
    ],
  };

  function loadTools() {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } =
      jest.requireActual('node:fs');
    const { join } = jest.requireActual('node:path');
    const { tmpdir } = jest.requireActual('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'vantik-tools-'));
    const policyPath = join(dir, 'policy.json');
    const outboxPath = join(dir, 'outbox.jsonl');
    writeFileSync(join(dir, 'context.json'), JSON.stringify(PACK));
    writeFileSync(
      policyPath,
      JSON.stringify({
        ...POLICY,
        contextPath: join(dir, 'context.json'),
        outboxPath,
      }),
    );

    const tools: Record<string, PiTool> = {};
    const env = process.env.VANTIK_POLICY;
    process.env.VANTIK_POLICY = policyPath;
    vantik({
      on: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: () => undefined,
      registerTool: (tool) => {
        tools[tool.name] = tool;
      },
    });
    process.env.VANTIK_POLICY = env;

    const outbox = () =>
      existsSync(outboxPath)
        ? (readFileSync(outboxPath, 'utf8') as string)
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    return { tools, outbox };
  }

  it('registers the read and write tools', () => {
    expect(
      Object.keys(loadTools().tools)
        .filter((name) => name.startsWith('vantik_'))
        .sort(),
    ).toEqual([
      'vantik_criterion_met',
      'vantik_issue',
      'vantik_knowledge',
      'vantik_note',
      'vantik_remember',
    ]);
  });

  it('marks every tool essential, so omp shows it to the model', () => {
    const { tools } = loadTools();

    expect(Object.values(tools).length).toBeGreaterThan(0);
    for (const tool of Object.values(tools)) {
      expect(tool.loadMode).toBe('essential');
    }
  });

  it('reads the issue and the knowledge from the pack', async () => {
    const { tools } = loadTools();

    const issue = (await tools.vantik_issue.execute('t', {})).content[0].text;
    expect(issue).toContain('# ENG-42: Keep the last row');
    expect(issue).toContain('- [ ] Keeps the last row (id: c1)');
    expect(findKnowledge(PACK, 'paged rows')).toBe(
      '- GOTCHA (src/importer): Rows are paged by 500.',
    );
    expect(findKnowledge(PACK, '')).toContain('Deploys go through Forgejo.');
    expect(describeIssue({})).toContain('(No description.)');
  });

  it('queues writes to the outbox, and refuses a criterion the issue does not have', async () => {
    const { tools, outbox } = loadTools();

    await tools.vantik_note.execute('t', { body: 'Found it.' });
    await tools.vantik_criterion_met.execute('t', {
      id: 'c1',
      evidence: 'spec passes',
    });
    await tools.vantik_remember.execute('t', {
      content: 'Rows are paged by 500.',
      kind: 'GOTCHA',
      citations: [{ path: 'src/importer.ts', lines: '80-90' }],
    });
    await expect(
      tools.vantik_criterion_met.execute('t', { id: 'nope', evidence: 'x' }),
    ).rejects.toThrow('No criterion has the id nope');

    expect(outbox()).toEqual([
      { v: 1, type: 'note', body: 'Found it.' },
      { v: 1, type: 'criterion', id: 'c1', evidence: 'spec passes' },
      {
        v: 1,
        type: 'remember',
        content: 'Rows are paged by 500.',
        kind: 'GOTCHA',
        citations: [{ path: 'src/importer.ts', lines: '80-90' }],
      },
    ]);
  });
});

/**
 * Pi asks for the model's catalog maximum on every call, and a gateway
 * reserves credit for all of it: 128k Sonnet tokens is about $1.92 held per
 * call, so an account with $0.91 left could make none.
 */
describe('capping what a call asks for', () => {
  const CAP = 32000;

  it.each([
    ['chat completions', { max_tokens: 128000 }, { max_tokens: CAP }],
    [
      'chat completions, newer field',
      { max_completion_tokens: 128000 },
      { max_completion_tokens: CAP },
    ],
    ['responses', { max_output_tokens: 128000 }, { max_output_tokens: CAP }],
    [
      'Google',
      { generationConfig: { maxOutputTokens: 65536, temperature: 1 } },
      { generationConfig: { maxOutputTokens: CAP, temperature: 1 } },
    ],
    [
      'Bedrock',
      { inferenceConfig: { maxTokens: 64000 } },
      { inferenceConfig: { maxTokens: CAP } },
    ],
  ])('lowers %s', (_api, payload, expected) => {
    expect(capOutputTokens({ model: 'm', ...payload }, CAP)).toEqual({
      model: 'm',
      ...expected,
    });
  });

  it('leaves a call that already asks for less alone', () => {
    expect(capOutputTokens({ max_tokens: 4096 }, CAP)).toBeUndefined();
    expect(capOutputTokens({ messages: [] }, CAP)).toBeUndefined();
    expect(capOutputTokens('not a payload', CAP)).toBeUndefined();
  });

  it.each([
    [
      'Anthropic thinking',
      {
        max_tokens: 128000,
        thinking: { type: 'enabled', budget_tokens: 30000 },
      },
      'max_tokens',
    ],
    [
      'OpenRouter reasoning',
      { max_tokens: 128000, reasoning: { max_tokens: 30000 } },
      'max_tokens',
    ],
  ])('keeps room to answer above the %s budget', (_api, payload, field) => {
    const capped = capOutputTokens(payload, CAP) as Record<string, unknown>;

    expect(capped[field]).toBe(30000 + 4096);
  });

  it('keeps room above a Google thinking budget', () => {
    expect(
      capOutputTokens(
        {
          generationConfig: {
            maxOutputTokens: 65536,
            thinkingConfig: { thinkingBudget: 32768 },
          },
        },
        CAP,
      ),
    ).toEqual({
      generationConfig: {
        maxOutputTokens: 32768 + 4096,
        thinkingConfig: { thinkingBudget: 32768 },
      },
    });
  });

  it('is applied to every call when the policy sets it, and the host sets it', () => {
    const handlers: Array<(event: unknown) => unknown> = [];
    const { writeFileSync, mkdtempSync } = jest.requireActual('node:fs');
    const { join } = jest.requireActual('node:path');
    const { tmpdir } = jest.requireActual('node:os');
    const path = join(mkdtempSync(join(tmpdir(), 'vantik-cap-')), 'p.json');
    const env = process.env.VANTIK_POLICY;

    writeFileSync(path, JSON.stringify({ ...POLICY, maxOutputTokens: CAP }));
    process.env.VANTIK_POLICY = path;
    capModelCalls({
      on: (name, handler) => {
        if (name === 'before_provider_request') {
          handlers.push(handler as (event: unknown) => unknown);
        }
      },
      sendUserMessage: () => undefined,
      appendEntry: () => undefined,
    });
    process.env.VANTIK_POLICY = env;

    expect(handlers).toHaveLength(1);
    expect(handlers[0]({ payload: { max_tokens: 128000 } })).toEqual({
      max_tokens: CAP,
    });
    expect(guardrailPolicy({} as never).maxOutputTokens).toBe(
      AGENT_MAX_OUTPUT_TOKENS,
    );
  });
});
