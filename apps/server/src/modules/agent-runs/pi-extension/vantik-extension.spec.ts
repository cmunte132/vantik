/* eslint-disable turbo/no-undeclared-env-vars -- VANTIK_POLICY is the guest's, set here as the host would. */
import { extensionFiles, guardrailPolicy, POLICY_PATH } from './seed';
import vantik, {
  blockedReason,
  checkReminder,
  checkToolCall,
  GuardrailPolicy,
  hostsIn,
  isCheckCommand,
  repoRelative,
} from './vantik-extension';
import { guardrailOf } from '../executors/pi-events';

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
    expect(load(null).handlers).toEqual({});
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
